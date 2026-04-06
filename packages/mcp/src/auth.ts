/**
 * Simplified MCP OAuth token management.
 * Stores tokens per-server, injects auth headers, provides refresh skeleton.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface McpOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp ms
  tokenType?: string; // default: 'Bearer'
  scope?: string;
  serverName: string;
}

export interface McpOAuthConfig {
  clientId?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  callbackPort?: number;
  scopes?: string[];
}

const TOKEN_FILE_NAME = 'mcp-tokens.json';

function getTokenFilePath(): string {
  return join(homedir(), '.claude', TOKEN_FILE_NAME);
}

/**
 * Load all stored MCP tokens from disk.
 */
export function loadTokens(): Map<string, McpOAuthToken> {
  const tokens = new Map<string, McpOAuthToken>();
  try {
    const data = readFileSync(getTokenFilePath(), 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      for (const token of parsed) {
        if (token.serverName && token.accessToken) {
          tokens.set(token.serverName, token);
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — start with empty tokens
  }
  return tokens;
}

/**
 * Save tokens to disk.
 */
export function saveTokens(tokens: Map<string, McpOAuthToken>): void {
  const path = getTokenFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...tokens.values()], null, 2), 'utf-8');
}

/**
 * Store a token for a specific MCP server.
 */
export function storeToken(token: McpOAuthToken): void {
  const tokens = loadTokens();
  tokens.set(token.serverName, token);
  saveTokens(tokens);
}

/**
 * Get the stored token for a server.
 */
export function getToken(serverName: string): McpOAuthToken | null {
  const tokens = loadTokens();
  return tokens.get(serverName) ?? null;
}

/**
 * Remove a stored token.
 */
export function removeToken(serverName: string): boolean {
  const tokens = loadTokens();
  const existed = tokens.delete(serverName);
  if (existed) saveTokens(tokens);
  return existed;
}

/**
 * Check if a token is expired (with 60s buffer).
 */
export function isTokenExpired(token: McpOAuthToken): boolean {
  if (!token.expiresAt) return false; // No expiry = assume valid
  return Date.now() >= token.expiresAt - 60_000;
}

/**
 * Build an Authorization header value from a token.
 */
export function buildAuthHeader(token: McpOAuthToken): string {
  const type = token.tokenType ?? 'Bearer';
  return `${type} ${token.accessToken}`;
}

/**
 * Get auth headers for a server, or empty object if no token stored.
 */
export function getAuthHeaders(serverName: string): Record<string, string> {
  const token = getToken(serverName);
  if (!token) return {};
  if (isTokenExpired(token)) {
    // Token expired — caller should trigger refresh
    return {};
  }
  return { Authorization: buildAuthHeader(token) };
}

/**
 * Token refresh skeleton. Implement the actual HTTP refresh flow.
 * Returns the new token, or null if refresh failed.
 */
export async function refreshToken(
  token: McpOAuthToken,
  oauthConfig: McpOAuthConfig,
): Promise<McpOAuthToken | null> {
  if (!token.refreshToken || !oauthConfig.tokenUrl) {
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      ...(oauthConfig.clientId ? { client_id: oauthConfig.clientId } : {}),
    });

    const res = await fetch(oauthConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    const newToken: McpOAuthToken = {
      serverName: token.serverName,
      accessToken: String(data.access_token ?? ''),
      refreshToken: String(data.refresh_token ?? token.refreshToken),
      expiresAt: data.expires_in
        ? Date.now() + Number(data.expires_in) * 1000
        : undefined,
      tokenType: String(data.token_type ?? 'Bearer'),
      scope: data.scope ? String(data.scope) : token.scope,
    };

    if (newToken.accessToken) {
      storeToken(newToken);
      return newToken;
    }
    return null;
  } catch {
    return null;
  }
}
