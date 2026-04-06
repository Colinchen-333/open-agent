import { describe, expect, test } from 'bun:test';
import { expandEnvVars, expandConfigEnvVars, mergeScopedConfigs, type ScopedMcpServerConfig } from '../config-scope';

describe('expandEnvVars', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin', API_KEY: 'secret123' };

  test('expands ${VAR} syntax', () => {
    expect(expandEnvVars('${HOME}/projects', env)).toBe('/home/user/projects');
  });

  test('expands $VAR syntax', () => {
    expect(expandEnvVars('$HOME/projects', env)).toBe('/home/user/projects');
  });

  test('expands ${VAR:-default} with existing var', () => {
    expect(expandEnvVars('${HOME:-/tmp}', env)).toBe('/home/user');
  });

  test('expands ${VAR:-default} with missing var', () => {
    expect(expandEnvVars('${MISSING:-fallback}', env)).toBe('fallback');
  });

  test('leaves unresolved vars intact', () => {
    expect(expandEnvVars('${UNKNOWN}', env)).toBe('${UNKNOWN}');
  });

  test('expands multiple vars in one string', () => {
    expect(expandEnvVars('${HOME}:${PATH}', env)).toBe('/home/user:/usr/bin');
  });

  test('handles empty string', () => {
    expect(expandEnvVars('', env)).toBe('');
  });

  test('no expansion needed', () => {
    expect(expandEnvVars('plain text', env)).toBe('plain text');
  });
});

describe('expandConfigEnvVars', () => {
  const env = { DB_HOST: 'localhost', DB_PORT: '5432' };

  test('expands string values', () => {
    const config = { host: '${DB_HOST}', port: '${DB_PORT}' };
    const result = expandConfigEnvVars(config, env);
    expect(result.host).toBe('localhost');
    expect(result.port).toBe('5432');
  });

  test('preserves non-string values', () => {
    const config = { count: 5, enabled: true, host: '${DB_HOST}' };
    const result = expandConfigEnvVars(config, env);
    expect(result.count).toBe(5);
    expect(result.enabled).toBe(true);
  });

  test('expands nested objects', () => {
    const config = { db: { host: '${DB_HOST}' } };
    const result = expandConfigEnvVars(config, env);
    expect((result.db as any).host).toBe('localhost');
  });

  test('expands arrays of strings', () => {
    const config = { args: ['--host', '${DB_HOST}'] };
    const result = expandConfigEnvVars(config, env);
    expect((result.args as string[])[1]).toBe('localhost');
  });
});

describe('mergeScopedConfigs', () => {
  test('higher scope wins on conflict', () => {
    const configs: ScopedMcpServerConfig[] = [
      { config: { name: 'server1', url: 'local-url' }, scope: 'local' },
      { config: { name: 'server1', url: 'user-url' }, scope: 'user' },
    ];
    const merged = mergeScopedConfigs(configs);
    expect(merged.get('server1')?.scope).toBe('user');
    expect((merged.get('server1')?.config as any).url).toBe('user-url');
  });

  test('enterprise beats user', () => {
    const configs: ScopedMcpServerConfig[] = [
      { config: { name: 'srv', url: 'u' }, scope: 'user' },
      { config: { name: 'srv', url: 'e' }, scope: 'enterprise' },
    ];
    const merged = mergeScopedConfigs(configs);
    expect(merged.get('srv')?.scope).toBe('enterprise');
  });

  test('different servers coexist', () => {
    const configs: ScopedMcpServerConfig[] = [
      { config: { name: 'a' }, scope: 'local' },
      { config: { name: 'b' }, scope: 'user' },
    ];
    const merged = mergeScopedConfigs(configs);
    expect(merged.size).toBe(2);
  });

  test('managed has highest precedence', () => {
    const configs: ScopedMcpServerConfig[] = [
      { config: { name: 'x' }, scope: 'enterprise' },
      { config: { name: 'x' }, scope: 'managed', isManaged: true },
    ];
    const merged = mergeScopedConfigs(configs);
    expect(merged.get('x')?.isManaged).toBe(true);
  });
});
