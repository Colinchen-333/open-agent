import { describe, expect, test } from 'bun:test';
import { McpServerState } from '../server-state';

describe('McpServerState', () => {
  test('disable then isDisabled returns true', () => {
    const s = new McpServerState();
    s.disable('foo');
    expect(s.isDisabled('foo')).toBe(true);
    expect(s.disabledReason('foo')).toBe('user');
  });

  test('enable clears user disabled', () => {
    const s = new McpServerState();
    s.disable('foo');
    s.enable('foo');
    expect(s.isDisabled('foo')).toBe(false);
    expect(s.disabledReason('foo')).toBe(null);
  });

  test('policy block overrides user enable', () => {
    const s = new McpServerState();
    s.policyBlock('foo');
    s.enable('foo'); // user attempt to enable
    expect(s.isDisabled('foo')).toBe(true);
    expect(s.disabledReason('foo')).toBe('policy');
  });

  test('snapshot and restore round-trip', () => {
    const s = new McpServerState();
    s.disable('a');
    s.policyBlock('b');
    const snap = s.snapshot();
    const s2 = new McpServerState();
    s2.restore(snap);
    expect(s2.isDisabled('a')).toBe(true);
    expect(s2.isDisabled('b')).toBe(true);
    expect(s2.disabledReason('a')).toBe('user');
    expect(s2.disabledReason('b')).toBe('policy');
  });

  test('fresh server is not disabled', () => {
    const s = new McpServerState();
    expect(s.isDisabled('unknown')).toBe(false);
    expect(s.disabledReason('unknown')).toBe(null);
  });

  test('policyUnblock removes the policy block', () => {
    const s = new McpServerState();
    s.policyBlock('foo');
    s.policyUnblock('foo');
    expect(s.isDisabled('foo')).toBe(false);
    expect(s.disabledReason('foo')).toBe(null);
  });

  test('snapshot contains only the persisted servers', () => {
    const s = new McpServerState();
    s.disable('x');
    s.policyBlock('y');
    const snap = s.snapshot();
    expect(snap.userDisabled).toEqual(['x']);
    expect(snap.policyBlocked).toEqual(['y']);
  });

  test('restore with undefined arrays defaults to empty sets', () => {
    const s = new McpServerState();
    s.restore({});
    expect(s.isDisabled('anything')).toBe(false);
  });
});
