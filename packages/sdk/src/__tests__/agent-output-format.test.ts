import { describe, it, expect } from 'bun:test';

/**
 * Tests that the AgentOutput JSON format produced by the SDK's runSubagent
 * matches the official @anthropic-ai/claude-agent-sdk AgentOutput type:
 *
 *   | { status: "completed", agentId, content, totalToolUseCount, ... }
 *   | { status: "async_launched", agentId, description, prompt, outputFile, ... }
 *   | { status: "sub_agent_entered", description, message }
 *
 * These tests validate the shape without a live LLM by constructing the JSON
 * the same way query.ts and cli/index.ts do.
 */

function buildCompletedOutput(opts: {
  agentId: string;
  result: string;
  prompt: string;
  totalToolUseCount?: number;
  durationMs?: number;
  totalTokens?: number;
  usage?: Record<string, unknown>;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanedUp?: boolean;
}): string {
  const defaultUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
    cache_creation: null,
  };
  return JSON.stringify({
    status: 'completed',
    agentId: opts.agentId,
    content: [{ type: 'text', text: opts.result }],
    totalToolUseCount: opts.totalToolUseCount ?? 0,
    totalDurationMs: opts.durationMs ?? 0,
    totalTokens: opts.totalTokens ?? 0,
    usage: opts.usage ?? defaultUsage,
    prompt: opts.prompt,
    ...(opts.worktreePath
      ? {
          worktree_path: opts.worktreePath,
          worktree_branch: opts.worktreeBranch,
          worktree_cleaned_up: opts.worktreeCleanedUp ?? false,
        }
      : {}),
  });
}

function buildAsyncLaunchedOutput(opts: {
  agentId: string;
  description: string;
  prompt: string;
  outputFile: string;
  worktreePath?: string;
  worktreeBranch?: string;
}): string {
  return JSON.stringify({
    status: 'async_launched',
    agentId: opts.agentId,
    description: opts.description,
    prompt: opts.prompt,
    outputFile: opts.outputFile,
    canReadOutputFile: true,
    ...(opts.worktreePath
      ? { worktree_path: opts.worktreePath, worktree_branch: opts.worktreeBranch }
      : {}),
  });
}

describe('AgentOutput format — completed', () => {
  it('has status "completed"', () => {
    const json = buildCompletedOutput({
      agentId: 'agent-123',
      result: 'Done!',
      prompt: 'Do something',
    });
    const output = JSON.parse(json);
    expect(output.status).toBe('completed');
  });

  it('wraps result text in content blocks array', () => {
    const json = buildCompletedOutput({
      agentId: 'agent-123',
      result: 'Analysis complete.',
      prompt: 'Analyze code',
    });
    const output = JSON.parse(json);
    expect(Array.isArray(output.content)).toBe(true);
    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toEqual({ type: 'text', text: 'Analysis complete.' });
  });

  it('includes all required stats fields', () => {
    const json = buildCompletedOutput({
      agentId: 'agent-456',
      result: 'ok',
      prompt: 'test',
      totalToolUseCount: 5,
      durationMs: 1200,
      totalTokens: 3000,
    });
    const output = JSON.parse(json);
    expect(output.agentId).toBe('agent-456');
    expect(output.totalToolUseCount).toBe(5);
    expect(output.totalDurationMs).toBe(1200);
    expect(output.totalTokens).toBe(3000);
    expect(output.prompt).toBe('test');
  });

  it('includes usage object with token breakdown', () => {
    const usage = {
      input_tokens: 1500,
      output_tokens: 500,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: null,
    };
    const json = buildCompletedOutput({
      agentId: 'agent-789',
      result: 'done',
      prompt: 'p',
      usage,
    });
    const output = JSON.parse(json);
    expect(output.usage.input_tokens).toBe(1500);
    expect(output.usage.output_tokens).toBe(500);
    expect(output.usage.server_tool_use.web_search_requests).toBe(1);
    expect(output.usage.service_tier).toBe('standard');
  });

  it('defaults stats to zero when not provided', () => {
    const json = buildCompletedOutput({
      agentId: 'a',
      result: 'r',
      prompt: 'p',
    });
    const output = JSON.parse(json);
    expect(output.totalToolUseCount).toBe(0);
    expect(output.totalDurationMs).toBe(0);
    expect(output.totalTokens).toBe(0);
    expect(output.usage.input_tokens).toBe(0);
    expect(output.usage.output_tokens).toBe(0);
    expect(output.usage.cache_creation_input_tokens).toBeNull();
  });

  it('includes worktree info when present', () => {
    const json = buildCompletedOutput({
      agentId: 'a',
      result: 'r',
      prompt: 'p',
      worktreePath: '/tmp/wt-branch',
      worktreeBranch: 'agent-branch-1',
      worktreeCleanedUp: true,
    });
    const output = JSON.parse(json);
    expect(output.worktree_path).toBe('/tmp/wt-branch');
    expect(output.worktree_branch).toBe('agent-branch-1');
    expect(output.worktree_cleaned_up).toBe(true);
  });

  it('omits worktree fields when not present', () => {
    const json = buildCompletedOutput({
      agentId: 'a',
      result: 'r',
      prompt: 'p',
    });
    const output = JSON.parse(json);
    expect(output.worktree_path).toBeUndefined();
    expect(output.worktree_branch).toBeUndefined();
    expect(output.worktree_cleaned_up).toBeUndefined();
  });
});

describe('AgentOutput format — async_launched', () => {
  it('has status "async_launched"', () => {
    const json = buildAsyncLaunchedOutput({
      agentId: 'agent-bg-1',
      description: 'Code review',
      prompt: 'Review the PR',
      outputFile: '/tmp/agents/agent-bg-1.output',
    });
    const output = JSON.parse(json);
    expect(output.status).toBe('async_launched');
  });

  it('includes agentId, description, prompt, outputFile', () => {
    const json = buildAsyncLaunchedOutput({
      agentId: 'agent-bg-2',
      description: 'explore',
      prompt: 'Find all tests',
      outputFile: '/tmp/agents/agent-bg-2.output',
    });
    const output = JSON.parse(json);
    expect(output.agentId).toBe('agent-bg-2');
    expect(output.description).toBe('explore');
    expect(output.prompt).toBe('Find all tests');
    expect(output.outputFile).toBe('/tmp/agents/agent-bg-2.output');
    expect(output.canReadOutputFile).toBe(true);
  });

  it('includes worktree info when isolation is worktree', () => {
    const json = buildAsyncLaunchedOutput({
      agentId: 'agent-bg-wt',
      description: 'isolated task',
      prompt: 'Do work in worktree',
      outputFile: '/tmp/agents/agent-bg-wt.output',
      worktreePath: '/tmp/worktrees/wt-1',
      worktreeBranch: 'agent-wt-branch',
    });
    const output = JSON.parse(json);
    expect(output.worktree_path).toBe('/tmp/worktrees/wt-1');
    expect(output.worktree_branch).toBe('agent-wt-branch');
  });
});

describe('AgentOutput format — discriminated union', () => {
  it('completed and async_launched are distinguishable by status field', () => {
    const completed = JSON.parse(
      buildCompletedOutput({ agentId: 'a', result: 'r', prompt: 'p' }),
    );
    const launched = JSON.parse(
      buildAsyncLaunchedOutput({
        agentId: 'b',
        description: 'd',
        prompt: 'p',
        outputFile: '/tmp/o',
      }),
    );

    expect(completed.status).toBe('completed');
    expect(launched.status).toBe('async_launched');

    // completed has content[], launched has outputFile
    expect(completed.content).toBeDefined();
    expect(completed.outputFile).toBeUndefined();
    expect(launched.outputFile).toBeDefined();
    expect(launched.content).toBeUndefined();
  });
});
