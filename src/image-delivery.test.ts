import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as containerRunner from './container-runner.js';
import { 
  processGroupMessages, 
  _setRegisteredGroups, 
  _setChannels 
} from './index.js';
import * as db from './db.js';
import { Channel, RegisteredGroup, NewMessage } from './types.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getMessagesSince: vi.fn(),
  getOrRecoverCursor: vi.fn(() => ''),
  getRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getLastBotMessageTimestamp: vi.fn(() => ''),
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  setRouterState: vi.fn(),
  initDatabase: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    TIMEZONE: 'UTC',
    IDLE_TIMEOUT: 1000,
  };
});

describe('Image delivery in processGroupMessages', () => {
  const chatJid = 'test-chat@g.us';
  const group: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-folder',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };

  const mockChannel: Channel = {
    name: 'test-channel',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    sendImage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid) => jid === chatJid),
    disconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _setRegisteredGroups({ [chatJid]: group });
    _setChannels([mockChannel]);
  });

  it('calls channel.sendImage when agent returns images', async () => {
    const mockMessages: NewMessage[] = [{
      id: 'msg1',
      chat_jid: chatJid,
      sender: 'user1',
      sender_name: 'User One',
      content: '@Andy show me a cat',
      timestamp: new Date().toISOString(),
    }];

    vi.mocked(db.getMessagesSince).mockReturnValue(mockMessages);
    
    // Simulate container outputting an image
    vi.mocked(containerRunner.runContainerAgent).mockImplementation(async (g, input, onProcess, onOutput) => {
      if (onOutput) {
        await onOutput({
          status: 'success',
          result: 'Here is a cat',
          images: ['base64-cat-image'],
        });
      }
      return { status: 'success', result: 'Here is a cat', images: ['base64-cat-image'] };
    });

    await processGroupMessages(chatJid);

    expect(mockChannel.sendImage).toHaveBeenCalledWith(chatJid, 'base64-cat-image');
    expect(mockChannel.sendMessage).toHaveBeenCalledWith(chatJid, 'Here is a cat');
  });
});
