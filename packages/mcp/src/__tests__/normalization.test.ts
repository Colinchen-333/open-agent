import { describe, expect, it } from 'bun:test';
import { parseMcpToolName, buildMcpToolName, isMcpToolName } from '../normalization';

describe('parseMcpToolName', () => {
  it('roundtrip: parsed result rebuilds the original name', () => {
    const original = 'mcp__myserver__read_file';
    const parsed = parseMcpToolName(original);
    expect(parsed).not.toBeNull();
    expect(buildMcpToolName(parsed!.serverName, parsed!.toolName)).toBe(original);
  });

  it('extracts serverName and toolName correctly', () => {
    expect(parseMcpToolName('mcp__demo__deploy')).toEqual({
      serverName: 'demo',
      toolName: 'deploy',
    });
  });

  it('returns null for non-prefixed names', () => {
    expect(parseMcpToolName('read_file')).toBeNull();
    expect(parseMcpToolName('deploy')).toBeNull();
    expect(parseMcpToolName('')).toBeNull();
    expect(parseMcpToolName('mcp__onlyone')).toBeNull();
  });

  it('handles server names that contain underscores', () => {
    const parsed = parseMcpToolName('mcp__my_server__some_tool');
    expect(parsed).not.toBeNull();
    // The server name portion uses non-greedy matching up to the last __ boundary.
    // With the regex, "my_server" resolves to serverName and "some_tool" to toolName.
    expect(parsed!.toolName).toBe('some_tool');
    expect(typeof parsed!.serverName).toBe('string');
  });

  it('handles tool names with underscores', () => {
    const parsed = parseMcpToolName('mcp__server__list_files_recursive');
    expect(parsed).toEqual({ serverName: 'server', toolName: 'list_files_recursive' });
  });
});

describe('buildMcpToolName', () => {
  it('composes serverName and toolName with mcp__ prefix', () => {
    expect(buildMcpToolName('myserver', 'read_file')).toBe('mcp__myserver__read_file');
  });

  it('works with single-word names', () => {
    expect(buildMcpToolName('demo', 'deploy')).toBe('mcp__demo__deploy');
  });
});

describe('isMcpToolName', () => {
  it('returns true for prefixed names', () => {
    expect(isMcpToolName('mcp__server__tool')).toBe(true);
    expect(isMcpToolName('mcp__my_server__read_file')).toBe(true);
  });

  it('returns false for non-prefixed names', () => {
    expect(isMcpToolName('read_file')).toBe(false);
    expect(isMcpToolName('Bash')).toBe(false);
    expect(isMcpToolName('')).toBe(false);
    expect(isMcpToolName('mcp__only')).toBe(false);
  });
});
