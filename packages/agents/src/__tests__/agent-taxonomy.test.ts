import { describe, expect, test, beforeEach } from 'bun:test';
import {
  sendMessage,
  readMessages,
  getAllMessages,
  resetMailboxes,
  resolveAgentMode,
  getMailbox,
} from '../agent-taxonomy';

describe('mailbox', () => {
  beforeEach(() => resetMailboxes());

  test('sendMessage delivers to recipient', () => {
    sendMessage('alice', 'bob', 'hello');
    const msgs = getAllMessages('bob');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe('alice');
    expect(msgs[0].content).toBe('hello');
    expect(msgs[0].read).toBe(false);
  });

  test('readMessages returns unread and marks read', () => {
    sendMessage('a', 'b', 'msg1');
    sendMessage('a', 'b', 'msg2');
    const unread = readMessages('b');
    expect(unread).toHaveLength(2);
    // Reading again returns empty
    expect(readMessages('b')).toHaveLength(0);
  });

  test('getAllMessages returns all messages', () => {
    sendMessage('a', 'b', 'first');
    readMessages('b'); // mark read
    sendMessage('a', 'b', 'second');
    expect(getAllMessages('b')).toHaveLength(2);
  });

  test('messages don\'t leak between agents', () => {
    sendMessage('a', 'bob', 'for bob');
    sendMessage('a', 'carol', 'for carol');
    expect(getAllMessages('bob')).toHaveLength(1);
    expect(getAllMessages('carol')).toHaveLength(1);
  });

  test('getMailbox creates on demand', () => {
    const box = getMailbox('new-agent');
    expect(box.messages).toHaveLength(0);
  });

  test('resetMailboxes clears all', () => {
    sendMessage('a', 'b', 'msg');
    resetMailboxes();
    expect(getAllMessages('b')).toHaveLength(0);
  });
});

describe('resolveAgentMode', () => {
  test('coordinator mode', () => {
    expect(resolveAgentMode({ isCoordinator: true })).toBe('coordinator');
  });

  test('dream mode', () => {
    expect(resolveAgentMode({ isDream: true })).toBe('dream');
  });

  test('background mode', () => {
    expect(resolveAgentMode({ isBackground: true })).toBe('background');
  });

  test('normal mode by default', () => {
    expect(resolveAgentMode({})).toBe('normal');
  });

  test('coordinator takes precedence', () => {
    expect(resolveAgentMode({ isCoordinator: true, isBackground: true })).toBe('coordinator');
  });
});
