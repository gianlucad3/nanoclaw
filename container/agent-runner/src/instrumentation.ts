/**
 * OpenTelemetry instrumentation for the NanoClaw agent runner.
 *
 * When PHOENIX_COLLECTOR_ENDPOINT is set, traces are sent to a Phoenix
 * instance (e.g. `phoenix serve` on the host, reachable from the container
 * at http://host.containers.internal:6006).
 *
 * This file must be the first import in index.ts so the SDK is patched
 * before @anthropic-ai/claude-agent-sdk is imported.
 */

import * as ClaudeAgentSDK from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { register } from '@arizeai/phoenix-otel';
import type { TracerProvider } from '@opentelemetry/api';

const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;

export let tracerProvider: TracerProvider | null = null;

if (endpoint) {
  tracerProvider = register({
    projectName: process.env.PHOENIX_PROJECT_NAME || 'nanoclaw',
    url: endpoint,
    ...(process.env.PHOENIX_API_KEY ? { apiKey: process.env.PHOENIX_API_KEY } : {}),
  });

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.manuallyInstrument(ClaudeAgentSDK);

  // eslint-disable-next-line no-console
  console.error(`[instrumentation] Phoenix tracing enabled → ${endpoint}`);
}

export async function shutdownTracing(): Promise<void> {
  if (tracerProvider && 'shutdown' in tracerProvider) {
    await (tracerProvider as { shutdown(): Promise<void> }).shutdown();
  }
}
