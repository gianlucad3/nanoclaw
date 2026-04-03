/**
 * OpenTelemetry instrumentation for the NanoClaw agent runner.
 *
 * When PHOENIX_COLLECTOR_ENDPOINT is set, traces are sent to a Phoenix
 * instance (e.g. `phoenix serve` on the host, reachable from the container
 * at http://192.168.64.1:6006 — Apple Container bridge gateway IP).
 *
 * ESM module namespace objects are sealed — manuallyInstrument() cannot
 * patch them directly. Instead we pass a plain mutable wrapper object for
 * the instrumentation to patch, then re-export the (possibly wrapped) query
 * function so index.ts always calls the instrumented version.
 *
 * We use a manual span wrapper rather than ClaudeAgentSDKInstrumentation
 * because the SDK instrumentation's spans were silently not being exported
 * (the OISpan/OITracer wrapping layer appears incompatible with our setup).
 * Manual wrapping produces SpanImpl instances directly, which export reliably.
 */

import { query as _query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { register } from '@arizeai/phoenix-otel';
import { Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { MimeType, OpenInferenceSpanKind, SemanticConventions } from '@arizeai/openinference-semantic-conventions';

// Re-export SDK types that index.ts needs
export type { HookCallback, PreCompactHookInput };

const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;

export let tracerProvider: ReturnType<typeof register> | null = null;

// Maps active spans to their finalizer — called by the SIGTERM handler so it
// can end spans with whatever output was captured at signal time.
const activeSpans = new Map<Span, () => void>();

// Mutable wrapper that may be replaced with a tracing version
const sdkWrapper = { query: _query };

if (endpoint) {
  const url = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  tracerProvider = register({
    projectName: process.env.PHOENIX_PROJECT_NAME || 'nanoclaw',
    url,
    batch: false, // SimpleSpanProcessor: export each span immediately, no buffering.
  });

  // On SIGTERM (sent by claw/container-runner after output sentinel), end all
  // active spans and force-flush before exiting. Without this, the process dies
  // mid-await and spans are never exported.
  process.on('SIGTERM', async () => {
    for (const finalize of activeSpans.values()) {
      finalize();
    }
    activeSpans.clear();
    if (tracerProvider) {
      await tracerProvider.forceFlush();
    }
    process.exit(0);
  });

  // Manually wrap query() to create an AGENT span around each invocation.
  // We use the OTel API directly rather than ClaudeAgentSDKInstrumentation because
  // the official one was silently dropping spans in this environment.
  const originalQuery = sdkWrapper.query;
  sdkWrapper.query = function tracedQuery(...args: Parameters<typeof _query>) {
    const tracer = trace.getTracer('nanoclaw');
    const iterable = originalQuery(...args);

    // Context for turn-aware tracing
    const stream = (args[0] as { prompt?: unknown }).prompt as
      { queue?: Array<{ message?: { content?: unknown } }> } | undefined;
    
    // Track messages we've already used as inputs to spans
    let messagesSeen = 0;

    return {
      [Symbol.asyncIterator]() {
        const inner = iterable[Symbol.asyncIterator]();
        
        let currentSpan: Span | null = null;
        let lastOutput: string | undefined;

        const endCurrentSpan = (code: SpanStatusCode = SpanStatusCode.OK, err?: Error) => {
          if (!currentSpan) return;
          if (err) currentSpan.recordException(err);
          if (lastOutput !== undefined) {
            currentSpan.setAttribute(SemanticConventions.OUTPUT_VALUE, lastOutput);
            currentSpan.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
          }
          currentSpan.setStatus({ code });
          currentSpan.end();
          activeSpans.delete(currentSpan);
          currentSpan = null;
          lastOutput = undefined;
        };

        return {
          async next() {
            // Start a new span if we don't have one (start of query or after a 'result' message)
            if (!currentSpan) {
              // Try to find the input for this turn
              const inputMessage = stream?.queue?.[messagesSeen];
              const inputValue = typeof inputMessage?.message?.content === 'string'
                ? inputMessage.message!.content as string
                : undefined;
              
              if (inputValue !== undefined) {
                messagesSeen++;
              }

              currentSpan = tracer.startSpan('ClaudeAgent.query.turn', {
                attributes: {
                  [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
                  ...(inputValue !== undefined && {
                    [SemanticConventions.INPUT_VALUE]: inputValue,
                    [SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
                  }),
                },
              });
              activeSpans.set(currentSpan, () => endCurrentSpan());
            }

            try {
              const result = await inner.next();
              
              if (!result.done && result.value && (result.value as { type?: string }).type === 'result') {
                // Turn is complete
                const r = result.value as { result?: string };
                if (r.result) lastOutput = r.result;
                endCurrentSpan();
              } else if (result.done) {
                endCurrentSpan();
              }
              
              return result;
            } catch (err) {
              endCurrentSpan(SpanStatusCode.ERROR, err instanceof Error ? err : new Error(String(err)));
              throw err;
            }
          },
          async return(value?: unknown) {
            endCurrentSpan();
            return inner.return ? inner.return() : { done: true as const, value: value as never };
          },
        };
      },
    } as ReturnType<typeof _query>;
  };

  console.error(`[instrumentation] Phoenix tracing enabled → ${url}`);
}

// Export the patching query for index.ts to use
export const query = sdkWrapper.query;

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
  }
}
