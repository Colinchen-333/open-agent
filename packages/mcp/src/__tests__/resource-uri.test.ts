import { describe, expect, test } from 'bun:test';
import {
  parseMcpResourceRef,
  buildMcpResourceRef,
  isMcpResourceRef,
  resolveMcpResourceRef,
} from '../resource-uri';

describe('resource-uri', () => {
  test('parseMcpResourceRef extracts server and resource', () => {
    expect(parseMcpResourceRef('@mcp://myserver/path/to/file')).toEqual({
      serverName: 'myserver',
      resourceUri: 'path/to/file',
    });
  });

  test('parseMcpResourceRef handles nested schemes in resource URI', () => {
    expect(parseMcpResourceRef('@mcp://fs/file:///tmp/foo.txt')).toEqual({
      serverName: 'fs',
      resourceUri: 'file:///tmp/foo.txt',
    });
  });

  test('parseMcpResourceRef rejects non-mcp strings', () => {
    expect(parseMcpResourceRef('plain/text')).toBeNull();
    expect(parseMcpResourceRef('https://example.com')).toBeNull();
    expect(parseMcpResourceRef('@mcp://')).toBeNull();
    expect(parseMcpResourceRef('@mcp://server')).toBeNull(); // no slash after server
  });

  test('buildMcpResourceRef composes correctly', () => {
    expect(buildMcpResourceRef('srv', 'file:///x')).toBe('@mcp://srv/file:///x');
  });

  test('isMcpResourceRef predicate', () => {
    expect(isMcpResourceRef('@mcp://a/b')).toBe(true);
    expect(isMcpResourceRef('foo')).toBe(false);
  });

  test('resolveMcpResourceRef calls manager.readResource and returns contents', async () => {
    const mockManager = {
      readResource: async (serverName: string, uri: string) => ({
        contents: [{ uri, mimeType: 'text/plain', text: `content from ${serverName}:${uri}` }],
      }),
    };
    const contents = await resolveMcpResourceRef('@mcp://srv/my-doc', mockManager);
    expect(contents).toHaveLength(1);
    expect(contents[0]!.text).toContain('srv');
    expect(contents[0]!.text).toContain('my-doc');
  });

  test('resolveMcpResourceRef throws on malformed ref', async () => {
    const mockManager = { readResource: async () => ({ contents: [] }) };
    await expect(resolveMcpResourceRef('not-a-ref', mockManager as any)).rejects.toThrow(/valid @mcp:/);
  });
});
