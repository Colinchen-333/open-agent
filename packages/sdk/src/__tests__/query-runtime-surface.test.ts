import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolDefinition } from '@open-agent/tools';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import { BASH_SANDBOX_POLICY_FIELD } from '@open-agent/permissions';
import { createSession } from '../session.js';
import { query } from '../query.js';

function makeTempHome(prefix: string): { cwd: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  return {
    cwd,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeBlockingProvider(): { provider: LLMProvider; release(): void; waitUntilStarted(): Promise<void> } {
  let releaseRun: (() => void) | null = null;
  let startedResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  return {
    provider: {
      name: 'mock-blocking-provider',
      async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
        startedResolve?.();
        startedResolve = null;
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'message_end', message: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      },
      async listModels(): Promise<ModelInfo[]> {
        return [{
          value: 'mock-model',
          displayName: 'Mock Model',
          description: 'Blocking test model',
          supportsThinking: false,
          supportsStructuredOutput: true,
          supportsImages: false,
          supportsServerTools: false,
          supportsEffort: false,
        }];
      },
    },
    release() {
      releaseRun?.();
      releaseRun = null;
    },
    waitUntilStarted() {
      return started;
    },
  };
}

function makeMetadataProvider(models: ModelInfo[]): LLMProvider {
  return {
    name: 'mock-metadata-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      yield { type: 'message_end', message: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async listModels(): Promise<ModelInfo[]> {
      return models;
    },
  };
}

function makeMockProvider(responses: StreamEvent[][]): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-runtime-surface-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const events = responses[Math.min(callIndex, responses.length - 1)] ?? [];
      callIndex += 1;
      for (const event of events) {
        yield event;
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        value: 'mock-model',
        displayName: 'Mock Model',
        description: 'Runtime surface test model',
      }];
    },
  };
}

function toolUseResponse(
  toolId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): StreamEvent[] {
  return [
    { type: 'tool_use_start', id: toolId, name: toolName },
    { type: 'tool_use_delta', id: toolId, partial_json: JSON.stringify(toolInput) },
    { type: 'tool_use_end', id: toolId },
    { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } },
  ];
}

function textResponse(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } },
  ];
}

function makeBackgroundControlProvider(): LLMProvider {
  return {
    name: 'mock-session-background-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('background session worker aborted for test');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        value: 'mock-model',
        displayName: 'Mock Model',
        description: 'Background test model',
        supportsThinking: false,
        supportsStructuredOutput: true,
        supportsImages: false,
        supportsServerTools: false,
        supportsEffort: false,
      }];
    },
  };
}

async function waitForWorkerStatus(
  getWorker: (workerId: string) => Promise<{ status?: string } | null>,
  workerId: string,
  expectedStatus: string,
): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const worker = await getWorker(workerId);
    if (worker?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for worker ${workerId} to reach ${expectedStatus}`);
}

async function waitForSubagent(
  listRunningSubagents: () => Promise<Array<{ workerId: string }>>,
  workerId: string,
): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const workers = await listRunningSubagents();
    if (workers.some((entry) => entry.workerId === workerId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for subagent ${workerId} to appear`);
}

describe('SDK runtime control surface', () => {
  it('reports stable session idle/running state for hosts', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-session-state-');
    const blocking = makeBlockingProvider();
    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: blocking.provider,
      });

      expect(await session.getSessionState()).toMatchObject({
        status: 'idle',
        activeTurn: false,
        canAcceptInput: true,
        pendingInputCount: 0,
      });

      const turn = session.send('hello');
      const observed: string[] = [];
      const consume = (async () => {
        for await (const msg of turn) {
          observed.push(msg.type);
        }
      })();
      await blocking.waitUntilStarted();

      expect(await session.getSessionState()).toMatchObject({
        status: 'running',
        activeTurn: true,
        canAcceptInput: false,
      });

      blocking.release();
      await consume;

      const finalState = await session.getSessionState();
      expect(finalState.status).toBe('idle');
      expect(finalState.activeTurn).toBe(false);
      expect(finalState.canAcceptInput).toBe(true);
      expect(finalState.lastResultAt).toBeTruthy();
      expect(observed.includes('result')).toBe(true);
      session.close();
    } finally {
      cleanup();
    }
  });

  it('exposes provider capability flags instead of silent degradation', async () => {
    const q = query('provider capability test', {
      model: 'cap-model',
      provider: makeMetadataProvider([{
        value: 'cap-model',
        displayName: 'Capability Model',
        description: 'Capability surface test',
        supportsThinking: false,
        supportsAdaptiveThinking: false,
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
      }]),
    });

    try {
      expect(await q.getProviderCapabilities()).toMatchObject({
        provider: 'mock-metadata-provider',
        model: 'cap-model',
        thinkingMode: 'unsupported',
        structuredOutputMode: 'native',
        toolUseMode: 'native',
        serverToolsMode: 'unsupported',
        supportsThinking: false,
        supportsAdaptiveThinking: false,
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
      });
    } finally {
      q.close();
    }
  });

  it('supports registering and unregistering runtime tools between turns', async () => {
    const runtimeEchoTool: ToolDefinition = {
      name: 'RuntimeEcho',
      description: 'Echo runtime tool',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      async execute(input) {
        return String((input as { text?: string }).text ?? '');
      },
    };
    const q = query('runtime tools', {
      model: 'mock-model',
      provider: makeMetadataProvider([{
        value: 'mock-model',
        displayName: 'Mock Model',
        description: 'Runtime tool test model',
      }]),
    });

    try {
      const before = await q.listRegisteredTools();
      expect(before.some((tool) => tool.name === 'RuntimeEcho')).toBe(false);

      await expect(q.registerRuntimeTools([runtimeEchoTool])).resolves.toEqual({
        added: ['RuntimeEcho'],
        replaced: [],
      });
      const afterAdd = await q.listRegisteredTools();
      expect(afterAdd.some((tool) => tool.name === 'RuntimeEcho')).toBe(true);

      const runtimeState = await q.readRuntimeControlPlane();
      expect(runtimeState.runtime.capabilitySummary.totalTools).toBe(afterAdd.length);

      await expect(q.unregisterRuntimeTools(['RuntimeEcho'])).resolves.toEqual({
        removed: ['RuntimeEcho'],
      });
      const afterRemove = await q.listRegisteredTools();
      expect(afterRemove.some((tool) => tool.name === 'RuntimeEcho')).toBe(false);
    } finally {
      q.close();
    }
  });

  it('provides list/cancel aliases for running subagents', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-subagent-control-');
    try {
      const q = query('subagent control aliases', {
        cwd,
        model: 'mock-model',
        provider: makeBackgroundControlProvider(),
      });

      try {
        const worker = await q.launchWorker({
          prompt: 'run forever until cancelled',
          name: 'worker-alpha',
          teamName: 'alpha',
        });

        await waitForSubagent(
          () => q.listRunningSubagents({ teamName: 'alpha' }),
          worker.workerId,
        );
        const running = await q.listRunningSubagents({ teamName: 'alpha' });
        expect(running.some((entry) => entry.workerId === worker.workerId)).toBe(true);
        await expect(q.cancelSubagent(worker.workerId)).resolves.toEqual({ success: true });
      } finally {
        q.close();
      }
    } finally {
      cleanup();
    }
  });

  it('surfaces live permission control plane state and refreshes bash sandbox policy from session updates', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-runtime-permissions-');
    const observedPolicies: Array<{
      allowWritePaths: string[];
      denyReadPaths: string[];
      denyWritePaths: string[];
    }> = [];
    const runtimeAllowedDir = join(cwd, 'runtime-allowed');
    mkdirSync(runtimeAllowedDir, { recursive: true });
    const baselineDir = join(cwd, 'baseline');
    mkdirSync(baselineDir, { recursive: true });

    try {
      const q = query('refresh permissions', {
        cwd,
        model: 'mock-model',
        provider: makeMockProvider([
          toolUseResponse('bash-1', 'Bash', { command: 'pwd' }),
          toolUseResponse('bash-2', 'Bash', { command: 'pwd' }),
          textResponse('done'),
        ]),
        sandbox: {
          enabled: true,
          filesystem: {
            allowWrite: [baselineDir],
          },
        },
        canUseTool(toolName, input) {
          if (toolName !== 'Bash') {
            return true;
          }
          const policy = input[BASH_SANDBOX_POLICY_FIELD] as {
            allowWritePaths?: string[];
            denyReadPaths?: string[];
            denyWritePaths?: string[];
          } | undefined;
          observedPolicies.push({
            allowWritePaths: [...(policy?.allowWritePaths ?? [])],
            denyReadPaths: [...(policy?.denyReadPaths ?? [])],
            denyWritePaths: [...(policy?.denyWritePaths ?? [])],
          });
          if (observedPolicies.length === 1) {
            return {
              behavior: 'allow' as const,
              updatedPermissions: [{
                type: 'addDirectories' as const,
                destination: 'session' as const,
                directories: [runtimeAllowedDir],
              }],
            };
          }
          return { behavior: 'allow' as const };
        },
      });

      try {
        for await (const _message of q) {
          // Drain the turn so both Bash tool calls execute.
        }

        expect(observedPolicies).toHaveLength(2);
        expect(observedPolicies[0]?.allowWritePaths).toEqual(expect.arrayContaining([baselineDir]));
        expect(observedPolicies[0]?.allowWritePaths).not.toEqual(expect.arrayContaining([runtimeAllowedDir]));
        expect(observedPolicies[1]?.allowWritePaths).toEqual(expect.arrayContaining([
          baselineDir,
          runtimeAllowedDir,
        ]));

        const runtimeControlPlane = await q.readRuntimeControlPlane();
        expect(runtimeControlPlane.permissions.allowedPaths).toEqual([runtimeAllowedDir]);
        expect(Array.isArray(runtimeControlPlane.permissions.suspendedAllowRules)).toBe(true);
      } finally {
        q.close();
      }
    } finally {
      cleanup();
    }
  });
});
