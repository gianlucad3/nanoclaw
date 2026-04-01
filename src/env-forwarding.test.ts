/**
 * Runtime tests for buildContainerArgs env forwarding.
 *
 * Verifies that env vars from config.ts are actually passed as
 * -e flags to the container CLI command. Each test mocks the config
 * module with specific values and checks the resulting args array.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'container',
  CONTAINER_HOST_GATEWAY: '192.168.64.1',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => [
    '--mount',
    `type=bind,source=${h},target=${c},readonly`,
  ],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

function makeConfigMock(overrides: Record<string, unknown> = {}) {
  return {
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/test',
    GROUPS_DIR: '/tmp/test-groups',
    IDLE_TIMEOUT: 1800000,
    TIMEZONE: 'UTC',
    OLLAMA_HOST: '',
    OLLAMA_ADMIN_TOOLS: false,
    MLX_HOST: '',
    MLX_MODEL: '',
    PHOENIX_COLLECTOR_ENDPOINT: '',
    PHOENIX_API_KEY: '',
    PHOENIX_PROJECT_NAME: '',
    ...overrides,
  };
}

async function importBuildContainerArgs(
  configOverrides: Record<string, unknown>,
) {
  vi.doMock('./config.js', () => makeConfigMock(configOverrides));
  const mod = await import('./container-runner.js');
  return mod.buildContainerArgs;
}

beforeEach(() => {
  vi.resetModules();
});

describe('buildContainerArgs env forwarding', () => {
  it('forwards MLX_HOST when config value is non-empty', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      MLX_HOST: 'http://192.168.64.1:11435',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e MLX_HOST=http://192.168.64.1:11435');
  });

  it('does NOT forward MLX_HOST when config value is empty', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      MLX_HOST: '',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.filter((a: string) => a.includes('MLX_HOST'))).toHaveLength(0);
  });

  it('forwards OLLAMA_HOST when config value is non-empty', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      OLLAMA_HOST: 'http://192.168.64.1:11434',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain(
      '-e OLLAMA_HOST=http://192.168.64.1:11434',
    );
  });

  it('forwards MLX_MODEL when config value is non-empty', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      MLX_MODEL: 'test-model',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e MLX_MODEL=test-model');
  });

  it('forwards OLLAMA_ADMIN_TOOLS when enabled', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      OLLAMA_ADMIN_TOOLS: true,
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e OLLAMA_ADMIN_TOOLS=true');
  });

  it('always includes TZ', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      TIMEZONE: 'America/Los_Angeles',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e TZ=America/Los_Angeles');
  });

  it('always includes ANTHROPIC_BASE_URL pointing to credential proxy', async () => {
    const buildContainerArgs = await importBuildContainerArgs({});
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain(
      '-e ANTHROPIC_BASE_URL=http://192.168.64.1:3001',
    );
  });

  it('forwards ALL non-empty model host vars together', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      OLLAMA_HOST: 'http://192.168.64.1:11434',
      OLLAMA_ADMIN_TOOLS: true,
      MLX_HOST: 'http://192.168.64.1:11435',
      MLX_MODEL: 'test-model',
    });
    const args = buildContainerArgs([], 'test-container', true);
    const argsStr = args.join(' ');

    expect(argsStr).toContain('-e OLLAMA_HOST=http://192.168.64.1:11434');
    expect(argsStr).toContain('-e MLX_HOST=http://192.168.64.1:11435');
    expect(argsStr).toContain('-e MLX_MODEL=test-model');
    expect(argsStr).toContain('-e OLLAMA_ADMIN_TOOLS=true');
  });

  it('forwards PHOENIX_COLLECTOR_ENDPOINT when set', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      PHOENIX_COLLECTOR_ENDPOINT: 'http://host.containers.internal:6006',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain(
      '-e PHOENIX_COLLECTOR_ENDPOINT=http://host.containers.internal:6006',
    );
  });

  it('does NOT forward PHOENIX_COLLECTOR_ENDPOINT when empty', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      PHOENIX_COLLECTOR_ENDPOINT: '',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).not.toContain('PHOENIX_COLLECTOR_ENDPOINT');
  });

  it('forwards PHOENIX_API_KEY when set', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      PHOENIX_API_KEY: 'test-api-key',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e PHOENIX_API_KEY=test-api-key');
  });

  it('forwards PHOENIX_PROJECT_NAME when set', async () => {
    const buildContainerArgs = await importBuildContainerArgs({
      PHOENIX_PROJECT_NAME: 'my-project',
    });
    const args = buildContainerArgs([], 'test-container', true);
    expect(args.join(' ')).toContain('-e PHOENIX_PROJECT_NAME=my-project');
  });
});
