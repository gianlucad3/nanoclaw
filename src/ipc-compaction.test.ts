/**
 * Tests for the IPC memory compaction logic (processCompactionRequest).
 *
 * Uses real temp directories for filesystem operations, mocks only the
 * summarizer to avoid calling Ollama.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Temp dirs ───────────────────────────────────────────────────────────────
let tmpDir: string;
let groupsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-compaction-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(groupsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  mockSummarize.mockReset();
});

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockSummarize = vi.fn();

vi.mock('./services/local-summarizer.js', () => ({
  summarizeMemoryFile: (...args: unknown[]) => mockSummarize(...args),
}));

vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return groupsDir;
  },
  // Other config values needed by ipc.ts imports
  DATA_DIR: '/tmp/unused',
  IPC_POLL_INTERVAL: 60_000,
  TIMEZONE: 'UTC',
  OLLAMA_HOST: '',
}));

import { processCompactionRequest } from './ipc.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeProcessingFile(
  dir: string,
  payload: Record<string, unknown>,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'test_compact.json.processing');
  fs.writeFileSync(filePath, JSON.stringify(payload));
  return filePath;
}

function setupGroupDir(folder: string, content: string, isMain = false): void {
  const dir = path.join(groupsDir, isMain ? 'main' : folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('processCompactionRequest', () => {
  it('compacts CLAUDE.md end-to-end', async () => {
    const folder = 'test-group';
    const originalContent = '# Memory\nVerbose content to compact...';
    setupGroupDir(folder, originalContent);

    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: folder,
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
      priority_topics: [],
    });

    mockSummarize.mockResolvedValue('- compacted content');

    const lockCalls: string[] = [];
    const unlockCalls: string[] = [];

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: false,
      jid: 'test@g.us',
      deps: {
        lockGroup: (jid) => lockCalls.push(jid),
        unlockGroup: (jid) => unlockCalls.push(jid),
      },
    });

    // Verify lock/unlock sequence
    expect(lockCalls).toEqual(['test@g.us']);
    expect(unlockCalls).toEqual(['test@g.us']);

    // Verify summarizer was called with original content
    expect(mockSummarize).toHaveBeenCalledWith(originalContent);

    // Verify CLAUDE.md was updated
    const updated = fs.readFileSync(
      path.join(groupsDir, folder, 'CLAUDE.md'),
      'utf-8',
    );
    expect(updated).toBe('- compacted content');

    // Verify .processing file was cleaned up
    expect(fs.existsSync(processingPath)).toBe(false);
  });

  it('uses main dir for main groups', async () => {
    const folder = 'whatsapp_main';
    setupGroupDir(folder, '# Main memory', true); // creates groups/main/CLAUDE.md

    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: folder,
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
    });

    mockSummarize.mockResolvedValue('- main compacted');

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: true,
      jid: 'main@g.us',
      deps: { lockGroup: vi.fn(), unlockGroup: vi.fn() },
    });

    const updated = fs.readFileSync(
      path.join(groupsDir, 'main', 'CLAUDE.md'),
      'utf-8',
    );
    expect(updated).toBe('- main compacted');
  });

  it('rejects mismatched group_id (directory traversal)', async () => {
    const folder = 'legit-group';
    setupGroupDir(folder, '# Memory');

    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: '../other-group', // mismatch!
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
    });

    const lockGroup = vi.fn();

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: false,
      jid: 'legit@g.us',
      deps: { lockGroup, unlockGroup: vi.fn() },
    });

    // Should NOT have locked or called summarizer
    expect(lockGroup).not.toHaveBeenCalled();
    expect(mockSummarize).not.toHaveBeenCalled();

    // CLAUDE.md unchanged
    const content = fs.readFileSync(
      path.join(groupsDir, folder, 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).toBe('# Memory');
  });

  it('always unlocks group even when summarizer throws', async () => {
    const folder = 'error-group';
    setupGroupDir(folder, '# Memory');

    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: folder,
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
    });

    mockSummarize.mockRejectedValue(new Error('Ollama unreachable'));

    const lockCalls: string[] = [];
    const unlockCalls: string[] = [];

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: false,
      jid: 'err@g.us',
      deps: {
        lockGroup: (jid) => lockCalls.push(jid),
        unlockGroup: (jid) => unlockCalls.push(jid),
      },
    });

    // Lock was acquired AND released
    expect(lockCalls).toEqual(['err@g.us']);
    expect(unlockCalls).toEqual(['err@g.us']);

    // CLAUDE.md unchanged
    const content = fs.readFileSync(
      path.join(groupsDir, folder, 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).toBe('# Memory');

    // Error file written for agent
    const errorFile = path.join(memReqDir, `${folder}_compact_error.json`);
    expect(fs.existsSync(errorFile)).toBe(true);
    const errorPayload = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
    expect(errorPayload.error).toContain('Ollama unreachable');
  });

  it('skips unregistered group (null jid)', async () => {
    const folder = 'orphan-group';
    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: folder,
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
    });

    const lockGroup = vi.fn();

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: false,
      jid: null,
      deps: { lockGroup, unlockGroup: vi.fn() },
    });

    expect(lockGroup).not.toHaveBeenCalled();
    expect(mockSummarize).not.toHaveBeenCalled();
    // Processing file cleaned up
    expect(fs.existsSync(processingPath)).toBe(false);
  });

  it('handles missing CLAUDE.md gracefully', async () => {
    const folder = 'no-claude-md';
    // Don't create CLAUDE.md — only the directory
    fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });

    const memReqDir = path.join(tmpDir, 'mem_requests');
    const processingPath = writeProcessingFile(memReqDir, {
      group_id: folder,
      timestamp: new Date().toISOString(),
      files: ['CLAUDE.md'],
    });

    const lockGroup = vi.fn();

    await processCompactionRequest({
      processingPath,
      memoryRequestsDir: memReqDir,
      sourceGroup: folder,
      isMain: false,
      jid: 'no-claude@g.us',
      deps: { lockGroup, unlockGroup: vi.fn() },
    });

    expect(lockGroup).not.toHaveBeenCalled();
    expect(mockSummarize).not.toHaveBeenCalled();
  });
});
