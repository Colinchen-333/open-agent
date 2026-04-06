import { describe, expect, test } from 'bun:test';
import { expandConfigEnvVars } from '../config-scope';

describe('MCP config env expansion integration', () => {
  test('expands URL from env', () => {
    const env = { MCP_URL: 'http://localhost:3000' };
    const config = expandConfigEnvVars({ type: 'http', url: '${MCP_URL}' }, env);
    expect(config.url).toBe('http://localhost:3000');
  });

  test('expands headers from env', () => {
    const env = { TOKEN: 'abc123' };
    const config = expandConfigEnvVars({
      type: 'sse',
      url: 'http://server',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    }, env);
    expect((config.headers as any).Authorization).toBe('Bearer abc123');
  });

  test('expands args array from env', () => {
    const env = { PORT: '8080' };
    const config = expandConfigEnvVars({
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '${PORT}'],
    }, env);
    expect((config.args as string[])[2]).toBe('8080');
  });

  test('preserves non-string values', () => {
    const config = expandConfigEnvVars({ type: 'http', url: 'x', timeout: 5000 }, {});
    expect(config.timeout).toBe(5000);
  });
});
