import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentExecutor } from '../agent-executor.js';
import type { AgentDefinition } from '@open-agent/core';

// Minimal mock provider that simulates a successful LLM response
const mockProvider = {
  name: 'mock',
  async *chat() {
    yield { type: 'text_delta', text: 'test response' };
    yield {
      type: 'message_end',
      message: {},
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  },
  async listModels() {
    return [];
  },
};

// Minimal mock tool map
const mockTools = new Map();

// Minimal agent definition for testing
const mockDefinition: AgentDefinition = {
  description: 'Test agent',
  prompt: 'You are a test agent.',
  name: 'test-agent',
  mode: 'default',
};

// We mock AgentRunner to avoid real LLM calls
const mockRunResult = {
  agentId: 'mock-agent-id',
  result: 'mock result text',
  isError: false,
  numTurns: 2,
  durationMs: 100,
};

// Capture constructor options for assertions (A2 test)
let lastRunnerOptions: any = null;

// Mock the agent-runner module
mock.module('../agent-runner.js', () => ({
  AgentRunner: class MockAgentRunner {
    constructor(opts: any) {
      lastRunnerOptions = opts;
    }
    async run(_prompt: string) {
      return mockRunResult;
    }
    getAgentId() {
      return 'mock-agent-id';
    }
  },
}));

describe('AgentExecutor', () => {
  let executor: AgentExecutor;

  beforeEach(() => {
    executor = new AgentExecutor();
    lastRunnerOptions = null;
  });

  describe('execute()', () => {
    it('returns agentId and result on success', async () => {
      const { agentId, result } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Do a test task',
        cwd: '/tmp',
      });

      expect(typeof agentId).toBe('string');
      expect(agentId.startsWith('agent-')).toBe(true);
      expect(result).toBe('mock result text');
    });

    it('returns session with completed state', async () => {
      const { session } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Do a test task',
        cwd: '/tmp',
      });

      expect(session.state).toBe('completed');
      expect(session.numTurns).toBe(2);
      expect(session.result).toBe('mock result text');
      expect(session.completedAt).toBeDefined();
      expect(session.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('uses resume ID when provided', async () => {
      const resumeId = 'agent-resume-test-12';
      const { agentId } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Resume task',
        cwd: '/tmp',
        resume: resumeId,
      });

      expect(agentId).toBe(resumeId);
    });

    it('sets optional fields on session', async () => {
      const { session } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Task with options',
        cwd: '/tmp',
        name: 'my-agent',
        model: 'sonnet',
        mode: 'acceptEdits',
        teamName: 'test-team',
      });

      expect(session.name).toBe('my-agent');
      expect(session.model).toBe('sonnet');
      expect(session.mode).toBe('acceptEdits');
      expect(session.teamName).toBe('test-team');
    });

    it('throws and marks session as failed when runner throws', async () => {
      mock.module('../agent-runner.js', () => ({
        AgentRunner: class FailingRunner {
          constructor(_opts: any) {}
          async run(_prompt: string): Promise<never> {
            throw new Error('Runner failed');
          }
        },
      }));

      const failExecutor = new AgentExecutor();

      await expect(
        failExecutor.execute({
          definition: mockDefinition,
          provider: mockProvider as any,
          tools: mockTools,
          prompt: 'Failing task',
          cwd: '/tmp',
        })
      ).rejects.toThrow('Runner failed');

      // Restore mock (must capture options for A2 tests)
      mock.module('../agent-runner.js', () => ({
        AgentRunner: class MockAgentRunner {
          constructor(opts: any) {
            lastRunnerOptions = opts;
          }
          async run(_prompt: string) {
            return mockRunResult;
          }
        },
      }));
    });
  });

  describe('getAgent()', () => {
    it('returns session state after execute', async () => {
      const { agentId } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Test',
        cwd: '/tmp',
      });

      const session = executor.getAgent(agentId);
      expect(session).not.toBeNull();
      expect(session!.agentId).toBe(agentId);
      expect(session!.state).toBe('completed');
    });

    it('returns null for unknown agent ID', () => {
      const session = executor.getAgent('non-existent-agent-id');
      expect(session).toBeNull();
    });

    it('loads session from disk if not in memory', async () => {
      const { agentId } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Test persistence',
        cwd: '/tmp',
      });

      // Create a new executor instance (empty in-memory map)
      const newExecutor = new AgentExecutor();
      const session = newExecutor.getAgent(agentId);
      expect(session).not.toBeNull();
      expect(session!.agentId).toBe(agentId);
    });
  });

  describe('listAgents()', () => {
    it('returns empty array when no agents have been executed', () => {
      const agents = executor.listAgents();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBe(0);
    });

    it('returns all tracked agents after execution', async () => {
      await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Task 1',
        cwd: '/tmp',
      });
      await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Task 2',
        cwd: '/tmp',
      });

      const agents = executor.listAgents();
      expect(agents.length).toBe(2);
    });
  });

  describe('stopAgent()', () => {
    it('returns false for unknown agent', () => {
      const result = executor.stopAgent('non-existent');
      expect(result).toBe(false);
    });

    it('returns false for completed agent', async () => {
      const { agentId } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Task',
        cwd: '/tmp',
      });

      // Agent is already completed, cannot stop
      const result = executor.stopAgent(agentId);
      expect(result).toBe(false);
    });
  });

  describe('executeInBackground()', () => {
    it('returns immediately with agentId and outputFile', async () => {
      const start = Date.now();
      const { agentId, outputFile } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Background task',
        cwd: '/tmp',
      });
      const elapsed = Date.now() - start;

      // Should return quickly (background, not blocked on agent completion)
      expect(elapsed).toBeLessThan(500);
      expect(typeof agentId).toBe('string');
      expect(agentId.startsWith('agent-')).toBe(true);
      expect(typeof outputFile).toBe('string');
      expect(outputFile).toContain(agentId);
      expect(outputFile).toContain('.output');
    });

    it('creates the output file immediately', async () => {
      const { outputFile } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Background file test',
        cwd: '/tmp',
      });

      const { existsSync } = await import('fs');
      expect(existsSync(outputFile)).toBe(true);
    });

    it('stores agent in running state immediately', async () => {
      const { agentId } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Background state test',
        cwd: '/tmp',
      });

      const session = executor.getAgent(agentId);
      expect(session).not.toBeNull();
      // State may be 'spawning' or 'running' immediately after call
      expect(['spawning', 'running', 'completed']).toContain(session!.state);
    });

    it('stopAgent returns true for running background agent', async () => {
      // To test stopAgent on a running agent, we need to intercept before completion.
      // We manipulate the internal map directly after executeInBackground returns.
      const { agentId } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Stoppable task',
        cwd: '/tmp',
      });

      // Force the session into 'running' state (simulate mid-execution check)
      const session = (executor as any).agents.get(agentId);
      if (session) {
        session.state = 'running';
        const result = executor.stopAgent(agentId);
        expect(result).toBe(true);

        const stopped = executor.getAgent(agentId);
        expect(stopped!.state).toBe('shutdown');
      }
    });

    it('A2: executeInBackground 传递 onEvent 给 AgentRunner', async () => {
      const onEvent = (_e: any) => {};
      await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Background with onEvent',
        cwd: '/tmp',
        onEvent,
      });

      // 后台 agent 异步执行，等它启动
      await new Promise((r) => setTimeout(r, 100));

      expect(lastRunnerOptions).not.toBeNull();
      expect(lastRunnerOptions.onEvent).toBe(onEvent);
    });

    it('executeInBackground 传递 abortSignal 给 AgentRunner', async () => {
      const { agentId } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Background with abort signal',
        cwd: '/tmp',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(lastRunnerOptions).not.toBeNull();
      expect(lastRunnerOptions.abortSignal).toBeDefined();

      const session = (executor as any).agents.get(agentId);
      if (session) session.state = 'running';
      const stopped = executor.stopAgent(agentId);
      expect(stopped).toBe(true);
    });

    it('execute (前台) 也传递 onEvent', async () => {
      const onEvent = (_e: any) => {};
      await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Foreground with onEvent',
        cwd: '/tmp',
        onEvent,
      });

      expect(lastRunnerOptions).not.toBeNull();
      expect(lastRunnerOptions.onEvent).toBe(onEvent);
    });

    it('uses resume ID for background agent', async () => {
      const resumeId = 'agent-bg-resume-001';
      const { agentId, outputFile } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Resume background',
        cwd: '/tmp',
        resume: resumeId,
      });

      expect(agentId).toBe(resumeId);
      expect(outputFile).toContain(resumeId);
    });
  });

  describe('Session persistence', () => {
    it('saveSession persists and loadSession restores state', async () => {
      const { agentId, session: originalSession } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Persistence test',
        cwd: '/tmp',
        name: 'persistent-agent',
        teamName: 'test-team',
      });

      // New executor reads from disk
      const freshExecutor = new AgentExecutor();
      const loadedSession = freshExecutor.getAgent(agentId);

      expect(loadedSession).not.toBeNull();
      expect(loadedSession!.agentId).toBe(originalSession.agentId);
      expect(loadedSession!.state).toBe('completed');
      expect(loadedSession!.name).toBe('persistent-agent');
      expect(loadedSession!.teamName).toBe('test-team');
      expect(loadedSession!.result).toBe('mock result text');
    });
  });

  describe('MAX_CONCURRENT_BACKGROUND', () => {
    it('is set to 10', () => {
      expect(AgentExecutor.MAX_CONCURRENT_BACKGROUND).toBe(10);
    });

    it('throws when exceeding the concurrent background limit', async () => {
      const agentsMap = (executor as any).agents as Map<string, any>;

      for (let i = 0; i < AgentExecutor.MAX_CONCURRENT_BACKGROUND; i++) {
        agentsMap.set(`saturate-${i}`, {
          agentId: `saturate-${i}`,
          agentType: 'test',
          state: 'running',
          startedAt: new Date().toISOString(),
          model: 'default',
          numTurns: 0,
          durationMs: 0,
        });
      }

      await expect(
        executor.executeInBackground({
          definition: mockDefinition,
          provider: mockProvider as any,
          tools: mockTools,
          prompt: 'This should be rejected',
          cwd: '/tmp',
        }),
      ).rejects.toThrow(/Maximum concurrent background agents/);
    });

    it('allows new background agent after one completes', async () => {
      const agentsMap = (executor as any).agents as Map<string, any>;

      for (let i = 0; i < AgentExecutor.MAX_CONCURRENT_BACKGROUND; i++) {
        agentsMap.set(`fill-${i}`, {
          agentId: `fill-${i}`,
          agentType: 'test',
          state: 'running',
          startedAt: new Date().toISOString(),
          model: 'default',
          numTurns: 0,
          durationMs: 0,
        });
      }

      // Mark one as completed to free a slot
      agentsMap.get('fill-0')!.state = 'completed';

      const { agentId } = await executor.executeInBackground({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Fits in freed slot',
        cwd: '/tmp',
      });

      expect(typeof agentId).toBe('string');
    });
  });

  describe('Usage stats passthrough', () => {
    it('session has usage fields defaulting gracefully when runner omits them', async () => {
      const { session } = await executor.execute({
        definition: mockDefinition,
        provider: mockProvider as any,
        tools: mockTools,
        prompt: 'Stats test',
        cwd: '/tmp',
      });

      // mockRunResult doesn't include the new fields, so they should be undefined
      // The session interface has them as optional — consumers use ?? fallbacks
      expect(session.numTurns).toBe(2);
      expect(session.totalToolUseCount).toBeUndefined();
      expect(session.totalTokens).toBeUndefined();
      expect(session.usage).toBeUndefined();
    });
  });

  describe('A3: AgentRunner onEvent try-catch 源码保护', () => {
    it('agent-runner.ts 中 onEvent 调用被 try-catch 包裹', async () => {
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const source = readFileSync(
        resolve(import.meta.dir, '../agent-runner.ts'),
        'utf-8',
      );
      // 验证 onEvent 相关代码在 try-catch 块内
      expect(source).toMatch(/try\s*\{[\s\S]*?onEvent[\s\S]*?\}\s*catch/);
    });
  });
});
