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
  // the OISpan/OITracer layer was silently dropping spans.
  const originalQuery = sdkWrapper.query;
  sdkWrapper.query = function tracedQuery(...args: Parameters<typeof _query>) {
    const tracer = trace.getTracer('nanoclaw');
    // Read the first message from MessageStream's queue (already pushed before query() is called)
    const stream = (args[0] as { prompt?: unknown }).prompt as
      { queue?: Array<{ message?: { content?: unknown } }> } | undefined;
    const inputValue = typeof stream?.queue?.[0]?.message?.content === 'string'
      ? stream.queue[0].message!.content as string
      : undefined;

    const iterable = originalQuery(...args);
    return {
      [Symbol.asyncIterator]() {
        const span = tracer.startSpan('ClaudeAgent.query', {
          attributes: {
            [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
            ...(inputValue !== undefined && {
              [SemanticConventions.INPUT_VALUE]: inputValue,
              [SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
            }),
          },
        });
        const inner = iterable[Symbol.asyncIterator]();
        let lastOutput: string | undefined;
        const endSpan = (code: SpanStatusCode, err?: Error) => {
          if (!activeSpans.has(span)) return; // already ended
          activeSpans.delete(span);
          if (err) span.recordException(err);
          if (lastOutput !== undefined) {
            span.setAttribute(SemanticConventions.OUTPUT_VALUE, lastOutput);
            span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
          }
          span.setStatus({ code });
          span.end();
        };
        // Register finalizer — captures lastOutput by reference so SIGTERM gets
        // whatever was collected at signal time.
        activeSpans.set(span, () => endSpan(SpanStatusCode.OK));
        return {
          async next() {
            try {
              const result = await inner.next();
              // Capture result text as output so it's available when span ends
              if (!result.done && result.value && (result.value as { type?: string }).type === 'result') {
                const r = result.value as { result?: string };
                if (r.result) lastOutput = r.result;
              }
              if (result.done) endSpan(SpanStatusCode.OK);
              return result;
            } catch (err) {
              endSpan(SpanStatusCode.ERROR, err instanceof Error ? err : new Error(String(err)));
              throw err;
            }
          },
          async return(value?: unknown) {
            endSpan(SpanStatusCode.OK);
            return inner.return ? inner.return() : { done: true as const, value: value as never };
          },
        };
      },
    } as ReturnType<typeof _query>;
  };

  console.error(`[instrumentation] Phoenix tracing enabled → ${url}`);
}

// Export the (possibly patched) query for index.ts to use
export const query = sdkWrapper.query;

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
  }
}
