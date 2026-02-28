import { describe, it, expect } from 'bun:test';
import { listSessions } from '../list-sessions.js';

describe('listSessions()', () => {
  it('is a function', () => {
    expect(typeof listSessions).toBe('function');
  });

  it('returns an array', async () => {
    const result = await listSessions({ dir: '/tmp/open-agent-test-nonexistent' });
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty for a directory with no sessions', async () => {
    const result = await listSessions({ dir: '/tmp/open-agent-test-nonexistent' });
    expect(result).toHaveLength(0);
  });

  it('supports default all-project listing when no dir is provided', async () => {
    const result = await listSessions();
    expect(Array.isArray(result)).toBe(true);
  });

  it('supports limit option', async () => {
    const result = await listSessions({ dir: '/tmp/open-agent-test-nonexistent', limit: 1 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('supports the legacy string dir signature', async () => {
    const result = await listSessions('/tmp/open-agent-test-nonexistent');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('listSessions export from SDK', () => {
  it('is re-exported from the SDK index', async () => {
    const sdk = await import('../index.js');
    expect(typeof sdk.listSessions).toBe('function');
  });
});
