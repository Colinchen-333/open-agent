import { describe, expect, it } from 'bun:test';
import { createDefaultToolRegistry, ToolRegistry, type ToolDefinition } from '../index.js';
import { describeToolCapability, resolveToolCapability } from '../capability.js';

describe('tool capability metadata', () => {
  it('uses explicit capability metadata when provided on a tool definition', () => {
    const tool: ToolDefinition = {
      name: 'CustomWriter',
      description: 'Writes a custom artifact',
      inputSchema: { type: 'object', properties: {} },
      capability: {
        category: 'filesystem',
        tags: ['custom', 'artifact'],
        risk: 'medium',
        needsWorkspaceWrite: true,
        concurrencySafe: false,
        readOnly: false,
      },
      async execute() {
        return 'ok';
      },
    };

    const resolved = resolveToolCapability(tool);
    expect(resolved.source).toBe('explicit');
    expect(resolved.category).toBe('filesystem');
    expect(resolved.tags).toEqual(['custom', 'artifact']);
    expect(resolved.risk).toBe('medium');
    expect(resolved.needsWorkspaceWrite).toBe(true);
    expect(resolved.concurrencySafe).toBe(false);
    expect(resolved.readOnly).toBe(false);

    const exported = describeToolCapability(tool);
    expect(exported.name).toBe('CustomWriter');
    expect(exported.capability.category).toBe('filesystem');
  });

  it('derives stable capability metadata for built-in tools in the default registry', () => {
    const registry = createDefaultToolRegistry('/tmp/project');

    const bash = registry.getCapability('Bash');
    expect(bash).toBeDefined();
    expect(bash?.capability.category).toBe('shell');
    expect(bash?.capability.risk).toBe('high');
    expect(bash?.capability.needsWorkspaceWrite).toBe(true);
    expect(bash?.capability.concurrencySafe).toBe(false);
    expect(bash?.capability.source).toBe('derived');

    const read = registry.getCapability('Read');
    expect(read).toBeDefined();
    expect(read?.capability.category).toBe('filesystem');
    expect(read?.capability.readOnly).toBe(true);
    expect(read?.capability.risk).toBe('low');
    expect(read?.capability.needsWorkspaceWrite).toBe(false);
  });

  it('exports a capability manifest alongside the existing LLM tool payload', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'Ping',
      description: 'A tiny probe tool',
      inputSchema: { type: 'object', properties: {} },
      capability: {
        category: 'utility',
        tags: ['probe'],
        readOnly: true,
        concurrencySafe: true,
        needsWorkspaceWrite: false,
        risk: 'low',
      },
      async execute() {
        return 'pong';
      },
    });

    const manifest = registry.exportCapabilityManifest();
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe('Ping');
    expect(manifest.tools[0].capability.category).toBe('utility');
    expect(registry.getForLLM()).toEqual([
      {
        name: 'Ping',
        description: 'A tiny probe tool',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
  });
});
