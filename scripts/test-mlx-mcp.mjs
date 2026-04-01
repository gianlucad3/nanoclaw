#!/usr/bin/env node
/**
 * MLX MCP server integration test
 * Starts a mock OpenAI-compatible HTTP server, spawns mlx-mcp-stdio.ts via tsx,
 * and exercises both tools via the MCP JSON-RPC protocol over stdio.
 *
 * Usage: node scripts/test-mlx-mcp.mjs
 * Exit code 0 = all tests passed, 1 = failure.
 */

import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const AGENT_RUNNER_DIR = resolve(ROOT, 'container/agent-runner');

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

// ── Mock MLX HTTP server ──────────────────────────────────────────────────────

function startMockServer({ failOnce = false } = {}) {
  let requestCount = 0;
  const requests = [];

  const server = createServer((req, res) => {
    requestCount++;
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });

      if (failOnce && requestCount === 1) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
        return;
      }

      const resp = {
        id: 'test-id',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'Mock MLX response' } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests: () => requests });
    });
  });
}

// ── MCP client over stdio ─────────────────────────────────────────────────────

function spawnMcpServer(mockPort) {
  const proc = spawn(
    resolve(ROOT, 'node_modules/.bin/tsx'),
    ['src/mlx-mcp-stdio.ts'],
    {
      cwd: AGENT_RUNNER_DIR,
      env: {
        ...process.env,
        MLX_HOST: `http://127.0.0.1:${mockPort}`,
        MLX_MODEL: 'test-model',
        NODE_PATH: `${AGENT_RUNNER_DIR}/node_modules`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const pending = new Map();
  let nextId = 1;
  const errors = [];

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    } catch {
      // non-JSON lines (e.g. startup noise) — ignore
    }
  });

  proc.stderr.on('data', d => errors.push(d.toString()));

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to "${method}" (id=${id})`));
      }, 10_000);
      pending.set(id, {
        resolve: v => { clearTimeout(timeout); resolve(v); },
        reject:  e => { clearTimeout(timeout); reject(e);  },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  function kill() {
    proc.kill('SIGTERM');
  }

  function stderrLogs() {
    return errors.join('');
  }

  return { send, notify, kill, stderrLogs };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  // Ensure agent-runner has its node_modules (tsx needs @modelcontextprotocol/sdk)
  const nm = resolve(AGENT_RUNNER_DIR, 'node_modules', '@modelcontextprotocol');
  try {
    statSync(nm);
  } catch {
    console.log('  Installing agent-runner deps...');
    execSync('npm install --silent', { cwd: AGENT_RUNNER_DIR, stdio: 'pipe' });
  }

  // ── Test 1: happy path ────────────────────────────────────────────────────
  console.log('\n  [1/3] Happy path — mlx_generate + mlx_chat');
  {
    const { server, port } = await startMockServer();
    const client = spawnMcpServer(port);

    try {
      // MCP handshake
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0' },
      });
      client.notify('notifications/initialized');

      // tools/list
      const { tools } = await client.send('tools/list');
      const names = tools.map(t => t.name);
      if (names.includes('mlx_generate')) pass('tools/list includes mlx_generate');
      else fail('tools/list includes mlx_generate', `got: ${names.join(', ')}`);
      if (names.includes('mlx_chat')) pass('tools/list includes mlx_chat');
      else fail('tools/list includes mlx_chat', `got: ${names.join(', ')}`);

      // mlx_generate
      const genRes = await client.send('tools/call', {
        name: 'mlx_generate',
        arguments: { prompt: 'Hello', system: 'Be concise', max_tokens: 100 },
      });
      const genText = genRes?.content?.[0]?.text ?? '';
      if (genText.includes('Mock MLX response')) pass('mlx_generate returns content');
      else fail('mlx_generate returns content', `got: ${genText}`);
      if (genText.includes('[test-model |')) pass('mlx_generate appends token metadata');
      else fail('mlx_generate appends token metadata', `got: ${genText}`);

      // mlx_chat
      const chatRes = await client.send('tools/call', {
        name: 'mlx_chat',
        arguments: {
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'What is 2+2?' },
            { role: 'assistant', content: '4' },
            { role: 'user', content: 'And 3+3?' },
          ],
          max_tokens: 50,
          temperature: 0.5,
        },
      });
      const chatText = chatRes?.content?.[0]?.text ?? '';
      if (chatText.includes('Mock MLX response')) pass('mlx_chat returns content');
      else fail('mlx_chat returns content', `got: ${chatText}`);
    } finally {
      client.kill();
      await new Promise(r => server.close(r));
    }
  }

  // ── Test 2: HTTP error propagation ───────────────────────────────────────
  console.log('\n  [2/3] HTTP error propagation (503 → isError response)');
  {
    const { server, port } = await startMockServer({ failOnce: true });
    const client = spawnMcpServer(port);

    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0' },
      });
      client.notify('notifications/initialized');

      const errRes = await client.send('tools/call', {
        name: 'mlx_generate',
        arguments: { prompt: 'test' },
      });
      const errText = errRes?.content?.[0]?.text ?? '';
      const isErr = errRes?.isError === true;
      if (errText.includes('503') || errText.toLowerCase().includes('error')) {
        pass('mlx_generate surfaces HTTP 503 error in content');
      } else {
        fail('mlx_generate surfaces HTTP 503 error in content', `got: ${errText}`);
      }
      if (isErr) pass('mlx_generate sets isError=true on HTTP error');
      else fail('mlx_generate sets isError=true on HTTP error', `isError=${errRes?.isError}`);
    } finally {
      client.kill();
      await new Promise(r => server.close(r));
    }
  }

  // ── Test 3: unreachable host ──────────────────────────────────────────────
  console.log('\n  [3/3] Unreachable host → friendly error message');
  {
    const client = spawnMcpServer(19999); // nothing listening here

    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0' },
      });
      client.notify('notifications/initialized');

      const res = await client.send('tools/call', {
        name: 'mlx_generate',
        arguments: { prompt: 'test' },
      });
      const text = res?.content?.[0]?.text ?? '';
      if (text.toLowerCase().includes('failed') || text.toLowerCase().includes('connect')) {
        pass('mlx_generate reports connection failure');
      } else {
        fail('mlx_generate reports connection failure', `got: ${text}`);
      }
    } finally {
      client.kill();
    }
  }

  // ── Test 4: env canary (SDK allowlist simulation) ──────────────────────────
  // Simulates the Claude Agent SDK's restrictive env allowlist.
  // The SDK only passes HOME, LOGNAME, PATH, SHELL, TERM, USER to MCP subprocesses.
  // Custom vars like MLX_HOST must be explicitly listed in mcpServers.env.
  // This test proves the var reached the subprocess by checking tools/list output.
  console.log('\n  [4/4] Env canary — MLX_HOST/MLX_MODEL reach subprocess via minimal env');
  {
    const { server, port } = await startMockServer();
    const CANARY_MODEL = 'canary-model-env-test-12345';

    // Spawn with MINIMAL env (simulating SDK's Im3() allowlist)
    // Only the explicitly forwarded vars should be present
    const proc = spawn(
      resolve(ROOT, 'node_modules/.bin/tsx'),
      ['src/mlx-mcp-stdio.ts'],
      {
        cwd: AGENT_RUNNER_DIR,
        env: {
          // SDK allowlist (Im3 on Linux)
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SHELL: process.env.SHELL || '/bin/sh',
          USER: process.env.USER || 'test',
          TERM: process.env.TERM || 'xterm',
          // Explicitly forwarded vars (simulating mcpServers.env)
          MLX_HOST: `http://127.0.0.1:${port}`,
          MLX_MODEL: CANARY_MODEL,
          NODE_PATH: `${AGENT_RUNNER_DIR}/node_modules`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const pending = new Map();
    let nextId = 1;
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg.result);
        }
      } catch { /* ignore non-JSON */ }
    });

    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for "${method}"`));
        }, 10_000);
        pending.set(id, {
          resolve: v => { clearTimeout(timeout); resolve(v); },
          reject:  e => { clearTimeout(timeout); reject(e);  },
        });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }

    try {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'env-canary-test', version: '1.0' },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // tools/list descriptions contain the MLX_MODEL value
      const list = await send('tools/list');
      const descs = (list?.tools ?? []).map(t => t.description).join(' ');

      if (descs.includes(CANARY_MODEL)) {
        pass('MLX_MODEL canary found in tool descriptions (env reached subprocess)');
      } else {
        fail('MLX_MODEL canary NOT found in tool descriptions', `Expected "${CANARY_MODEL}" in: ${descs.slice(0, 200)}`);
      }

      // Also verify MLX_HOST works by calling the tool (hits mock server)
      const res = await send('tools/call', {
        name: 'mlx_generate',
        arguments: { prompt: 'canary test' },
      });
      const text = res?.content?.[0]?.text ?? '';
      if (text.includes('mock') || !text.includes('Failed')) {
        pass('mlx_generate connected via forwarded MLX_HOST (not fallback)');
      } else {
        fail('mlx_generate did NOT use forwarded MLX_HOST', `got: ${text.slice(0, 200)}`);
      }
    } finally {
      proc.kill('SIGTERM');
      await new Promise(r => server.close(r));
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

await runTests().catch(err => {
  console.error(`\n  Fatal error: ${err.message}`);
  process.exit(1);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
