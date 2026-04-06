import { describe, expect, test } from 'bun:test';
import { resolveHeaders, createEnvHeadersHelper } from '../headers-helper';

describe('resolveHeaders', () => {
  test('returns static headers when no helper', async () => {
    const headers = await resolveHeaders({ 'X-Api-Key': 'test' });
    expect(headers['X-Api-Key']).toBe('test');
  });

  test('merges dynamic headers over static', async () => {
    const headers = await resolveHeaders(
      { 'X-Static': 'a' },
      async () => ({ 'X-Dynamic': 'b' }),
    );
    expect(headers['X-Static']).toBe('a');
    expect(headers['X-Dynamic']).toBe('b');
  });

  test('dynamic overrides static on conflict', async () => {
    const headers = await resolveHeaders(
      { 'Auth': 'old' },
      async () => ({ 'Auth': 'new' }),
    );
    expect(headers['Auth']).toBe('new');
  });

  test('returns empty when no headers and no helper', async () => {
    const headers = await resolveHeaders();
    expect(Object.keys(headers)).toHaveLength(0);
  });
});

describe('createEnvHeadersHelper', () => {
  test('reads from env vars', async () => {
    process.env.TEST_TOKEN = 'abc123';
    const helper = createEnvHeadersHelper({ Authorization: 'TEST_TOKEN' });
    const headers = await helper();
    expect(headers['Authorization']).toBe('abc123');
    delete process.env.TEST_TOKEN;
  });

  test('applies prefix', async () => {
    process.env.TEST_TOKEN2 = 'xyz';
    const helper = createEnvHeadersHelper({ Authorization: 'TEST_TOKEN2' }, 'Bearer');
    const headers = await helper();
    expect(headers['Authorization']).toBe('Bearer xyz');
    delete process.env.TEST_TOKEN2;
  });

  test('skips missing env vars', async () => {
    delete process.env.NONEXISTENT;
    const helper = createEnvHeadersHelper({ Auth: 'NONEXISTENT' });
    const headers = await helper();
    expect(headers['Auth']).toBeUndefined();
  });
});
