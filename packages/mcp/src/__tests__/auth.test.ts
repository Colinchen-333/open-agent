import { describe, expect, test } from 'bun:test';
import {
  isTokenExpired,
  buildAuthHeader,
  type McpOAuthToken,
} from '../auth';

// Test token expiry and header building (no disk I/O)
describe('isTokenExpired', () => {
  test('returns false when no expiresAt', () => {
    const token: McpOAuthToken = { accessToken: 'x', serverName: 's' };
    expect(isTokenExpired(token)).toBe(false);
  });

  test('returns false when token is fresh', () => {
    const token: McpOAuthToken = {
      accessToken: 'x',
      serverName: 's',
      expiresAt: Date.now() + 3600_000,
    };
    expect(isTokenExpired(token)).toBe(false);
  });

  test('returns true when token is expired', () => {
    const token: McpOAuthToken = {
      accessToken: 'x',
      serverName: 's',
      expiresAt: Date.now() - 1000,
    };
    expect(isTokenExpired(token)).toBe(true);
  });

  test('returns true within 60s buffer', () => {
    const token: McpOAuthToken = {
      accessToken: 'x',
      serverName: 's',
      expiresAt: Date.now() + 30_000, // 30s from now, within 60s buffer
    };
    expect(isTokenExpired(token)).toBe(true);
  });
});

describe('buildAuthHeader', () => {
  test('builds Bearer header by default', () => {
    const token: McpOAuthToken = { accessToken: 'abc123', serverName: 's' };
    expect(buildAuthHeader(token)).toBe('Bearer abc123');
  });

  test('uses custom token type', () => {
    const token: McpOAuthToken = { accessToken: 'xyz', serverName: 's', tokenType: 'Basic' };
    expect(buildAuthHeader(token)).toBe('Basic xyz');
  });
});
