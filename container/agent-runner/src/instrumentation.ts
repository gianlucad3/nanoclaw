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
 */

import { query as _query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { register } from '@arizeai/phoenix-otel';
import type { TracerProvider } from '@opentelemetry/api';

// Re-export SDK types that index.ts needs
export type { HookCallback, PreCompactHookInput };

const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;

export let tracerProvider: TracerProvider | null = null;

// Mutable wrapper that the instrumentation can patch freely
const sdkWrapper = { query: _query };

if (endpoint) {
  tracerProvider = register({
    projectName: process.env.PHOENIX_PROJECT_NAME || 'nanoclaw',
    url: endpoint,
    ...(process.env.PHOENIX_API_KEY ? { apiKey: process.env.PHOENIX_API_KEY } : {}),
  });

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.manuallyInstrument(sdkWrapper);

  // eslint-disable-next-line no-console
  console.error(`[instrumentation] Phoenix tracing enabled → ${endpoint}`);
}

// Export the (possibly patched) query for index.ts to use
export const query = sdkWrapper.query;

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider && 'shutdown' in tracerProvider) {
    await (tracerProvider as { shutdown(): Promise<void> }).shutdown();
  }
}
