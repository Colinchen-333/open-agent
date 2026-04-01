import { describe, it, expect } from 'bun:test';
import type {
  SDKMessage,
  SDKProgressMessage,
  SDKTombstoneMessage,
  SDKSystemInformationalMessage,
  SDKSystemApiErrorMessage,
} from '../types.js';

describe('SDKMessage new types', () => {
  it('SDKProgressMessage has correct shape', () => {
    const msg: SDKProgressMessage = {
      type: 'progress',
      toolUseId: 'tu_123',
      toolName: 'bash',
      data: { stdout: 'hello' },
      uuid: 'test-uuid',
      session_id: 'test-session',
    };
    expect(msg.type).toBe('progress');
    expect(msg.toolName).toBe('bash');
  });

  it('SDKTombstoneMessage has correct shape', () => {
    const msg: SDKTombstoneMessage = {
      type: 'tombstone',
      originalMessageId: 'msg_abc',
      reason: 'compacted',
      uuid: 'test-uuid',
      session_id: 'test-session',
    };
    expect(msg.type).toBe('tombstone');
    expect(msg.reason).toBe('compacted');
  });

  it('SDKSystemInformationalMessage has correct shape', () => {
    const msg: SDKSystemInformationalMessage = {
      type: 'system',
      subtype: 'informational',
      message: 'something happened',
      uuid: 'test-uuid',
      session_id: 'test-session',
    };
    expect(msg.subtype).toBe('informational');
  });

  it('SDKSystemApiErrorMessage has correct shape', () => {
    const msg: SDKSystemApiErrorMessage = {
      type: 'system',
      subtype: 'api_error',
      message: 'rate limited',
      error: { status: 429, message: 'too many requests' },
      uuid: 'test-uuid',
      session_id: 'test-session',
    };
    expect(msg.subtype).toBe('api_error');
    expect(msg.error.status).toBe(429);
  });

  it('new types are assignable to SDKMessage', () => {
    const messages: SDKMessage[] = [
      {
        type: 'progress',
        toolUseId: 'tu_1',
        toolName: 'bash',
        data: null,
        uuid: 'u1',
        session_id: 's1',
      },
      {
        type: 'tombstone',
        originalMessageId: 'msg_1',
        reason: 'deleted',
        uuid: 'u2',
        session_id: 's1',
      },
      {
        type: 'system',
        subtype: 'informational',
        message: 'info',
        uuid: 'u3',
        session_id: 's1',
      },
      {
        type: 'system',
        subtype: 'turn_duration',
        message: 'turn took 2s',
        durationMs: 2000,
        uuid: 'u4',
        session_id: 's1',
      },
    ];
    expect(messages).toHaveLength(4);
  });
});
