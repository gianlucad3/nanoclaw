import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  IDLE_TIMEOUT: 300000,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue locking', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lockGroup prevents enqueueMessageCheck from starting a container', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    queue.lockGroup('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).not.toHaveBeenCalled();
  });

  it('lockGroup prevents enqueueTask from starting a container', async () => {
    const taskFn = vi.fn(async () => {});
    queue.lockGroup('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    await vi.advanceTimersByTimeAsync(100);
    expect(taskFn).not.toHaveBeenCalled();
  });

  it('unlockGroup drains queued messages', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    queue.lockGroup('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).not.toHaveBeenCalled();

    queue.unlockGroup('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).toHaveBeenCalledWith('group1@g.us');
  });

  it('unlockGroup drains queued tasks', async () => {
    const taskFn = vi.fn(async () => {});
    queue.lockGroup('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(100);
    expect(taskFn).not.toHaveBeenCalled();

    queue.unlockGroup('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(taskFn).toHaveBeenCalled();
  });

  it('isLocked reflects lock state', () => {
    expect(queue.isLocked('group1@g.us')).toBe(false);
    queue.lockGroup('group1@g.us');
    expect(queue.isLocked('group1@g.us')).toBe(true);
    queue.unlockGroup('group1@g.us');
    expect(queue.isLocked('group1@g.us')).toBe(false);
  });

  it('locked group in waitingGroups is skipped by drainWaiting', async () => {
    const completionCallbacks: Array<() => void> = [];
    const processed: string[] = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both concurrency slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue two more — group3 is locked, group4 is not
    queue.lockGroup('group3@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    // group4 should have been picked up, group3 still waiting
    expect(processed).toContain('group4@g.us');
    expect(processed).not.toContain('group3@g.us');
  });

  it('double unlock is safe (no-op)', () => {
    queue.lockGroup('group1@g.us');
    queue.unlockGroup('group1@g.us');
    queue.unlockGroup('group1@g.us');
    expect(queue.isLocked('group1@g.us')).toBe(false);
  });

  it('messages queued during lock are processed in order after unlock', async () => {
    const calls: string[] = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      calls.push(groupJid);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Lock group, queue two messages
    queue.lockGroup('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);

    // Unlock — pending messages should drain
    queue.unlockGroup('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toContain('group1@g.us');
  });
});
