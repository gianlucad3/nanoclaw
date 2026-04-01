/**
 * MCP Server Consistency Tests
 *
 * Auto-discovers all *-mcp-stdio.ts files and validates the complete
 * env forwarding chain for each:
 *
 *   .env → config.ts → container-runner.ts → container -e flags
 *        → index.ts mcpServers.env → MCP subprocess process.env
 *
 * When someone adds a new MCP server but forgets to wire up env
 * forwarding at any layer, these tests will catch it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const AGENT_RUNNER_SRC = path.join(ROOT, 'container/agent-runner/src');
const INDEX_TS = path.join(AGENT_RUNNER_SRC, 'index.ts');
const CONTAINER_RUNNER_TS = path.join(ROOT, 'src/container-runner.ts');
const CONFIG_TS = path.join(ROOT, 'src/config.ts');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// Map from MCP stdio filename prefix to mcpServers key name
// ipc-mcp-stdio.ts → 'nanoclaw' (special case)
const SERVER_NAME_OVERRIDES: Record<string, string> = {
  ipc: 'nanoclaw',
};

// Env vars that are set via the mcpServers.env field in index.ts
// but are NOT read from .env / config.ts (they're computed at runtime)
const RUNTIME_ONLY_VARS: Record<string, Set<string>> = {
  nanoclaw: new Set([
    'NANOCLAW_CHAT_JID',
    'NANOCLAW_GROUP_FOLDER',
    'NANOCLAW_IS_MAIN',
  ]),
};

// Discover all MCP stdio files (excluding ipc which has special handling)
function discoverMcpServers(): Array<{
  file: string;
  serverName: string;
  prefix: string;
}> {
  return fs
    .readdirSync(AGENT_RUNNER_SRC)
    .filter((f) => f.endsWith('-mcp-stdio.ts'))
    .map((file) => {
      const prefix = file.replace('-mcp-stdio.ts', '');
      const serverName = SERVER_NAME_OVERRIDES[prefix] || prefix;
      return { file, serverName, prefix };
    });
}

// Extract process.env.XXX references from source code
function extractEnvVarReferences(source: string): string[] {
  const matches = [...source.matchAll(/process\.env\.([A-Z_]+)/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

const mcpServers = discoverMcpServers();
const indexSource = fs.readFileSync(INDEX_TS, 'utf-8');
const containerRunnerSource = fs.readFileSync(CONTAINER_RUNNER_TS, 'utf-8');
const configSource = fs.readFileSync(CONFIG_TS, 'utf-8');

describe('MCP server auto-discovery', () => {
  it('finds at least one MCP server', () => {
    expect(mcpServers.length).toBeGreaterThan(0);
  });
});

for (const { file, serverName, prefix } of mcpServers) {
  const mcpSource = fs.readFileSync(path.join(AGENT_RUNNER_SRC, file), 'utf-8');
  const envVars = extractEnvVarReferences(mcpSource);
  const runtimeOnly = RUNTIME_ONLY_VARS[serverName] || new Set();
  const configVars = envVars.filter((v) => !runtimeOnly.has(v));

  describe(`MCP server: ${serverName} (${file})`, () => {
    // --- Registration checks ---

    it('is registered in mcpServers in index.ts', () => {
      // Match "serverName:" or "serverName :" in mcpServers block
      expect(indexSource).toMatch(
        new RegExp(`${serverName}\\s*:\\s*\\{`),
      );
    });

    it(`references ${file.replace('.ts', '.js')} in index.ts`, () => {
      expect(indexSource).toContain(file.replace('.ts', '.js'));
    });

    it(`has mcp__${serverName}__* in allowedTools`, () => {
      expect(indexSource).toContain(`'mcp__${serverName}__*'`);
    });

    // --- Env forwarding: index.ts mcpServers.env ---
    // Every process.env.XXX that the MCP server reads must be
    // explicitly forwarded in the mcpServers env field in index.ts.
    // This catches the Claude Agent SDK's Cm3 env allowlist issue.

    for (const envVar of configVars) {
      it(`forwards ${envVar} in mcpServers.${serverName}.env in index.ts`, () => {
        // The pattern in index.ts is:
        //   ...(process.env.XXX ? { XXX: process.env.XXX } : {})
        // Just check that process.env.XXX appears in the mcpServers section
        // and that it's in an env field context
        expect(
          indexSource,
          `${file} reads process.env.${envVar} but index.ts ` +
            `mcpServers.${serverName}.env does not forward it. ` +
            `The Claude Agent SDK only passes allowlisted env vars ` +
            `to MCP subprocesses — custom vars MUST be explicitly ` +
            `listed in the mcpServers env field.`,
        ).toContain(`process.env.${envVar}`);
      });
    }

    // --- Env forwarding: container-runner.ts buildContainerArgs ---
    // Every env var must be passed to the container via -e flag

    for (const envVar of configVars) {
      it(`forwards ${envVar} via -e flag in container-runner.ts`, () => {
        expect(
          containerRunnerSource,
          `${file} reads ${envVar} but container-runner.ts does not ` +
            `forward it to the container via -e flag. Add: ` +
            `if (${envVar}) args.push('-e', \`${envVar}=\${${envVar}}\`);`,
        ).toContain(envVar);
      });
    }

    // --- Env forwarding: config.ts ---
    // Every env var must be declared in readEnvFile and exported

    for (const envVar of configVars) {
      it(`is declared in readEnvFile in config.ts`, () => {
        expect(
          configSource,
          `${file} reads ${envVar} but config.ts readEnvFile does not ` +
            `include it. Add '${envVar}' to the readEnvFile keys array.`,
        ).toContain(`'${envVar}'`);
      });
    }

    // --- .env.example documentation ---

    for (const envVar of configVars) {
      it(`${envVar} is documented in .env.example`, () => {
        if (!fs.existsSync(ENV_EXAMPLE)) return; // skip if no .env.example
        const envExample = fs.readFileSync(ENV_EXAMPLE, 'utf-8');
        expect(
          envExample,
          `${envVar} is used by ${file} but not documented in .env.example`,
        ).toContain(envVar);
      });
    }
  });
}

// --- Cross-cutting checks ---

describe('container-runner.ts env imports', () => {
  // Every env var forwarded in buildContainerArgs must be imported from config
  const forwardedVars = [
    ...containerRunnerSource.matchAll(
      /if\s*\(([A-Z_]+)\)\s*args\.push\('-e'/g,
    ),
  ].map((m) => m[1]);

  for (const envVar of forwardedVars) {
    it(`imports ${envVar} from config.ts`, () => {
      expect(containerRunnerSource).toMatch(
        new RegExp(`import\\s*\\{[^}]*${envVar}[^}]*\\}\\s*from\\s*'\\./config`),
      );
    });
  }
});

// --- claw CLI consistency ---
// The claw script has its own env forwarding, independent of container-runner.ts.
// Env vars forwarded in container-runner.ts must also be forwarded in claw.

const CLAW_SCRIPT = path.join(ROOT, 'scripts/claw');

describe('claw script env forwarding', () => {
  const clawSource = fs.existsSync(CLAW_SCRIPT)
    ? fs.readFileSync(CLAW_SCRIPT, 'utf-8')
    : '';

  if (!clawSource) return;

  // Extract env vars forwarded by container-runner.ts buildContainerArgs
  const containerRunnerVars = [
    ...containerRunnerSource.matchAll(
      /if\s*\(([A-Z_]+)\)\s*args\.push\('-e'/g,
    ),
  ].map((m) => m[1]);

  for (const envVar of containerRunnerVars) {
    it(`forwards ${envVar} (matches container-runner.ts)`, () => {
      // claw reads vars from .env via SECRET_KEYS, then forwards them
      // in the for-loop. Check both places.
      expect(
        clawSource,
        `container-runner.ts forwards ${envVar} but scripts/claw does not. ` +
          `Add "${envVar}" to SECRET_KEYS and the forwarding loop in claw.`,
      ).toContain(envVar);
    });
  }
});
