import { describe, expect, it } from 'bun:test';
import { normalizeMcpAnnotations, normalizeMcpToolInfo } from '../tool-info';

describe('normalizeMcpAnnotations', () => {
  it('只保留支持的布尔 annotation 字段', () => {
    expect(normalizeMcpAnnotations({
      readOnly: true,
      destructive: false,
      openWorld: true,
      ignored: 'x',
    } as any)).toEqual({
      readOnly: true,
      destructive: false,
      openWorld: true,
    });
  });

  it('当没有有效布尔字段时省略 annotations', () => {
    expect(normalizeMcpAnnotations(undefined)).toBeUndefined();
    expect(normalizeMcpAnnotations({
      readOnly: 'yes',
      destructive: 1,
      openWorld: null,
    } as any)).toBeUndefined();
  });
});

describe('normalizeMcpAnnotations — MCP spec *Hint suffix mapping', () => {
  it('maps readOnlyHint → readOnly, destructiveHint → destructive, openWorldHint → openWorld, idempotentHint → idempotent', () => {
    expect(normalizeMcpAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    } as any)).toEqual({
      readOnly: true,
      destructive: false,
      openWorld: true,
      idempotent: false,
    });
  });

  it('Hint-suffixed form takes precedence over un-suffixed when both present', () => {
    expect(normalizeMcpAnnotations({
      readOnly: false,
      readOnlyHint: true,   // Hint wins
      destructive: true,
      destructiveHint: false, // Hint wins
    } as any)).toEqual({
      readOnly: true,
      destructive: false,
    });
  });

  it('idempotentHint is included in the result', () => {
    const result = normalizeMcpAnnotations({ idempotentHint: true } as any);
    expect(result).toEqual({ idempotent: true });
  });

  it('falls back to un-suffixed when *Hint fields are absent', () => {
    expect(normalizeMcpAnnotations({
      readOnly: true,
      idempotent: true,
    } as any)).toEqual({ readOnly: true, idempotent: true });
  });

  it('returns undefined when only non-boolean Hint fields are present', () => {
    expect(normalizeMcpAnnotations({
      readOnlyHint: 'yes',
      destructiveHint: null,
    } as any)).toBeUndefined();
  });
});

describe('normalizeMcpToolInfo', () => {
  it('保留 MCP annotations 并过滤非布尔值', () => {
    const tool = normalizeMcpToolInfo('demo', {
      name: 'deploy',
      description: 'Deploy remotely',
      annotations: {
        readOnly: false,
        destructive: true,
        openWorld: true,
      },
    });

    expect(tool).toEqual({
      name: 'deploy',
      description: 'Deploy remotely',
      inputSchema: { type: 'object', properties: {} },
      serverName: 'demo',
      annotations: {
        readOnly: false,
        destructive: true,
        openWorld: true,
      },
    });
  });

  it('没有有效 annotation 时不生成空 annotations 对象', () => {
    const tool = normalizeMcpToolInfo('demo', {
      name: 'echo',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      annotations: {
        readOnly: 'yes' as any,
        destructive: undefined,
        openWorld: undefined,
      },
    });

    expect(tool).toEqual({
      name: 'echo',
      description: undefined,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      serverName: 'demo',
    });
    expect('annotations' in tool).toBe(false);
  });
});
