import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildCapabilitySnapshotFromTools,
  formatCapabilitySnapshotForDisplay,
} from '../capability-command-helpers.js';
import { getSlashCommands, handleSlashCommand } from '../slash-commands.js';

describe('capability-command-helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds layered capability presets from tool names', () => {
    const snapshot = buildCapabilitySnapshotFromTools([
      'Read',
      'Write',
      'Bash',
      'Task',
      'ToolSearch',
      'WebFetch',
      'mcp__demo__echo',
    ]);

    expect(snapshot.totalTools).toBe(7);
    expect(snapshot.summary.groupCounts.files).toBe(2);
    expect(snapshot.summary.groupCounts.execution).toBe(1);
    expect(snapshot.summary.groupCounts.coordination).toBe(1);
    expect(snapshot.summary.groupCounts.integration).toBe(2);
    expect(snapshot.summary.groupCounts.external).toBe(1);
    expect(snapshot.summary.accessCounts['read-only']).toBe(1);
    expect(snapshot.summary.accessCounts.mutable).toBe(2);
    expect(snapshot.summary.accessCounts.meta).toBe(2);
    expect(snapshot.summary.accessCounts.external).toBe(2);

    const output = formatCapabilitySnapshotForDisplay(snapshot);
    expect(output).toContain('Capability snapshot:');
    expect(output).toContain('files');
    expect(output).toContain('execution');
    expect(output).toContain('coordination');
    expect(output).toContain('integration');
    expect(output).toContain('WebFetch');
    expect(output).toContain('mcp__demo__echo');
  });

  it('surfaces capabilities through slash commands and exports json', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'open-agent-capabilities-'));
    tempDirs.push(tempDir);
    const exportPath = join(tempDir, 'capabilities.json');

    const result = await handleSlashCommand('/capabilities json', {
      loop: {
        compact: async () => {},
        setModel: () => {},
        setThinking: () => {},
        setEffort: () => {},
        getTurnCount: () => 0,
        getTotalCost: () => ({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 }),
      } as any,
      cwd: tempDir,
      model: 'test-model',
      sessionId: 'session-1',
      tools: ['Read', 'Write', 'Bash', 'Task'],
    });

    expect(result?.handled).toBe(true);
    const parsed = JSON.parse(result?.output ?? '{}');
    expect(parsed.totalTools).toBe(4);
    expect(parsed.summary.groupCounts.files).toBe(2);
    expect(parsed.summary.groupCounts.execution).toBe(1);

    const exportResult = await handleSlashCommand(`/capabilities export ${exportPath}`, {
      loop: {
        compact: async () => {},
        setModel: () => {},
        setThinking: () => {},
        setEffort: () => {},
        getTurnCount: () => 0,
        getTotalCost: () => ({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 }),
      } as any,
      cwd: tempDir,
      model: 'test-model',
      sessionId: 'session-1',
      tools: ['Read', 'Write', 'Bash', 'Task'],
    });

    expect(exportResult?.handled).toBe(true);
    expect(exportResult?.output).toContain(exportPath);
    const exported = JSON.parse(readFileSync(exportPath, 'utf-8'));
    expect(exported.presets.map((preset: { name: string }) => preset.name)).toContain('files');
  });

  it('exposes the new slash command in help output', () => {
    const commands = getSlashCommands();
    expect(commands.some((cmd) => cmd.name === '/capabilities')).toBe(true);
  });
});
