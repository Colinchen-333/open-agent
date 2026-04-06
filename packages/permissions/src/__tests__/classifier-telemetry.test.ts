import { describe, expect, test } from 'bun:test';
import { classifyPermissionRequest } from '../classifier';

describe('classifier telemetry', () => {
  test('whitelist returns stage and zero duration', async () => {
    const result = await classifyPermissionRequest(
      { toolName: 'Read', input: { file_path: '/test' }, toolUseId: 'tel-1' },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('whitelist');
    expect(result!.durationMs).toBe(0);
    expect(result!.approved).toBe(true);
  });

  test('annotation returns stage annotation', async () => {
    const result = await classifyPermissionRequest(
      { toolName: 'CustomTool', input: {}, toolUseId: 'tel-2', annotations: { readOnly: true } },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('annotation');
    expect(result!.durationMs).toBe(0);
  });

  test('LLM stage returns rawLlmResponse and measured duration', async () => {
    const mockProvider = {
      classify: async (_prompt: string) => {
        await new Promise(r => setTimeout(r, 5));
        return 'APPROVE\nLooks safe';
      },
    };
    const result = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'tel-3' },
      { llmProvider: mockProvider },
    );
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('llm');
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result!.rawLlmResponse).toBeDefined();
    expect(result!.rawLlmResponse).toContain('APPROVE');
  });

  test('LLM BLOCK stage returns rawLlmResponse', async () => {
    const result = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'tel-4' },
      {
        llmProvider: { classify: async () => 'BLOCK\nDangerous command' },
      },
    );
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('llm');
    expect(result!.approved).toBe(false);
    expect(result!.rawLlmResponse).toContain('BLOCK');
  });

  test('returns null when no LLM and not whitelisted', async () => {
    const result = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'tel-5' },
      {},
    );
    expect(result).toBeNull();
  });

  test('toolCategory is propagated from metadata.capability.category', async () => {
    const result = await classifyPermissionRequest(
      {
        toolName: 'CustomTool',
        input: {},
        toolUseId: 'tel-6',
        annotations: { readOnly: true },
        metadata: { capability: { category: 'filesystem' } },
      },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.toolCategory).toBe('filesystem');
  });

  test('toolCategory flows through LLM stage from metadata', async () => {
    const result = await classifyPermissionRequest(
      {
        toolName: 'Bash',
        input: { command: 'echo hi' },
        toolUseId: 'tel-7',
        metadata: { capability: { category: 'shell' } },
      },
      {
        llmProvider: { classify: async () => 'APPROVE\nSafe' },
      },
    );
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('llm');
    expect(result!.toolCategory).toBe('shell');
  });
});
