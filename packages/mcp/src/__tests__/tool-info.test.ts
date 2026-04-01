import { describe, expect, it } from 'bun:test';
import { normalizeMcpToolInfo } from '../tool-info';

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
        readOnly: undefined,
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
