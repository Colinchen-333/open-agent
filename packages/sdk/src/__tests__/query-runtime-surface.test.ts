import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolDefinition } from '@open-agent/tools';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import { BASH_SANDBOX_POLICY_FIELD } from '@open-agent/permissions';
import { createSdkMcpServer, tool } from '../mcp-helpers.js';
import { createSession } from '../session.js';
import { query } from '../query.js';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

function createPluginFixture() {
  const pluginDir = mkdtempSync(join(tmpdir(), 'open-agent-runtime-prompt-plugin-'));
  mkdirSync(join(pluginDir, 'skills'), { recursive: true });
  mkdirSync(join(pluginDir, 'commands'), { recursive: true });
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });

  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'runtime-review-kit',
    version: '1.0.0',
    description: 'Runtime prompt plugin fixture',
    hooks: {
      UnknownEvent: [
        { command: 'echo invalid-hook', timeout: 5 },
      ],
      PreToolUse: [
        { command: 'echo plugin-hook', timeout: 5 },
      ],
    },
  }, null, 2));
  writeFileSync(join(pluginDir, 'skills', 'runtime-review.md'), `---
name: runtime-review
description: Runtime review skill
---
Use this skill for runtime review tasks.`);
  writeFileSync(join(pluginDir, 'commands', 'runtime-review.md'), `---
name: runtime-review
description: Runtime review command
---
Run runtime review command body.`);
  writeFileSync(join(pluginDir, 'agents', 'runtime-reviewer.md'), `---
description: Runtime reviewer agent
model: sonnet
tools: Read
---
You are the runtime reviewer.`);

  return pluginDir;
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

function makePromptCaptureProvider(): { provider: LLMProvider; getPrompt(): string } {
  let capturedPrompt = '';
  return {
    provider: {
      name: 'mock-prompt-capture-provider',
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
        capturedPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
        yield { type: 'text_delta', text: 'captured' };
        yield { type: 'message_end', message: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      },
      async listModels(): Promise<ModelInfo[]> {
        return [{
          value: 'mock-model',
          displayName: 'Mock Model',
          description: 'Prompt capture test model',
          supportsThinking: false,
          supportsStructuredOutput: true,
          supportsImages: false,
          supportsServerTools: false,
          supportsEffort: false,
        }];
      },
    },
    getPrompt() {
      return capturedPrompt;
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

  it('streams live session state transitions without polling', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-session-state-stream-');
    const blocking = makeBlockingProvider();
    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: blocking.provider,
      });

      const iterator = session.subscribeSessionState()[Symbol.asyncIterator]();
      const initial = await iterator.next();
      expect(initial.value).toMatchObject({
        status: 'idle',
        activeTurn: false,
        canAcceptInput: true,
      });

      const turn = session.send('hello');
      const consume = (async () => {
        for await (const _msg of turn) {
          // drain
        }
      })();
      await blocking.waitUntilStarted();

      const running = await iterator.next();
      expect(running.value).toMatchObject({
        status: 'running',
        activeTurn: true,
        canAcceptInput: false,
      });

      blocking.release();
      await consume;

      const idleAgain = await iterator.next();
      expect(idleAgain.value).toMatchObject({
        status: 'idle',
        activeTurn: false,
        canAcceptInput: true,
        idleReason: 'awaiting_input',
      });

      await iterator.return?.();
      session.close();
    } finally {
      cleanup();
    }
  });

  it('injects runtime plugin, hook, and diagnostic prompt fragments into managed system prompts', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-runtime-prompt-surface-');
    const pluginDir = createPluginFixture();
    const capture = makePromptCaptureProvider();
    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: capture.provider,
        plugins: [{ type: 'local', path: pluginDir }],
        hooks: {
          Notification: [
            { command: 'echo session-hook', timeout: 5 },
          ],
        },
      });

      const turn = session.send('describe runtime surface');
      for await (const _msg of turn) {
        // drain
      }

      const prompt = capture.getPrompt();
      expect(prompt).toContain('# Runtime Plugins');
      expect(prompt).toContain('runtime-review-kit');
      expect(prompt).toContain('# Runtime Hook Surface');
      expect(prompt).toContain('PreToolUse');
      expect(prompt).toContain('Notification');
      expect(prompt).toContain('# Runtime Diagnostics');
      expect(prompt).toContain('Sources: hook: 1');
      session.close();
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('reloads project prompt context at turn boundaries when AGENT.md changes', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-turn-prompt-context-');
    const capture = makePromptCaptureProvider();
    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: capture.provider,
        settingSources: ['project'],
      });

      const firstTurn = session.send('first turn');
      for await (const _msg of firstTurn) {
        // drain
      }
      expect(capture.getPrompt()).not.toContain('Follow the freshly written project guidance.');

      writeFileSync(join(cwd, 'AGENT.md'), 'Follow the freshly written project guidance.\n', 'utf-8');

      const secondTurn = session.send('second turn');
      for await (const _msg of secondTurn) {
        // drain
      }

      expect(capture.getPrompt()).toContain('Follow the freshly written project guidance.');
      session.close();
    } finally {
      cleanup();
    }
  });

  it('refreshes effective hook surface from settings during an active session', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-runtime-hook-refresh-');
    const capture = makePromptCaptureProvider();
    const settingsDir = join(cwd, '.open-agent');
    mkdirSync(settingsDir, { recursive: true });

    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: capture.provider,
        settingSources: ['project'],
      });

      try {
        for await (const _msg of session.send('describe runtime surface before refresh')) {
          // drain
        }
        expect(capture.getPrompt()).not.toContain('Notification');

        writeJson(join(settingsDir, 'settings.json'), {
          hooks: {
            Notification: [
              { command: 'echo refreshed-hook', timeout: 5 },
            ],
          },
        });

        await session.refreshRuntimeSettings();

        for await (const _msg of session.send('describe runtime surface after refresh')) {
          // drain
        }

        const prompt = capture.getPrompt();
        expect(prompt).toContain('# Runtime Hook Surface');
        expect(prompt).toContain('Notification');
        expect(prompt).toContain('settings_json');
      } finally {
        session.close();
      }
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
        canUseTool(toolName: string, input: Record<string, unknown>) {
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

  it('refreshes runtime settings from disk and updates subsequent bash sandbox policies', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-settings-refresh-');
    const observedPolicies: string[][] = [];
    const settingsDir = join(cwd, '.open-agent');
    const initialAllowedDir = join(cwd, 'initial-allowed');
    const refreshedAllowedDir = join(cwd, 'refreshed-allowed');
    mkdirSync(settingsDir, { recursive: true });
    mkdirSync(initialAllowedDir, { recursive: true });
    mkdirSync(refreshedAllowedDir, { recursive: true });
    writeJson(join(settingsDir, 'settings.json'), {
      permissions: {
        allow: [{ toolName: 'Read' }],
        allowedPaths: [initialAllowedDir],
      },
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: [initialAllowedDir],
        },
      },
    });

    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        settingSources: ['project'],
        provider: makeMockProvider([
          toolUseResponse('bash-refresh-1', 'Bash', { command: 'pwd' }),
          textResponse('first'),
          toolUseResponse('bash-refresh-2', 'Bash', { command: 'pwd' }),
          textResponse('second'),
        ]),
        canUseTool(toolName: string, input: Record<string, unknown>) {
          if (toolName === 'Bash') {
            const policy = input[BASH_SANDBOX_POLICY_FIELD] as {
              allowWritePaths?: string[];
            } | undefined;
            observedPolicies.push([...(policy?.allowWritePaths ?? [])]);
          }
          return true;
        },
      } as any);

      try {
        for await (const _message of session.send('first turn')) {
          // drain
        }

        writeJson(join(settingsDir, 'settings.json'), {
          permissions: {
            allow: [{ toolName: 'Write' }],
            allowedPaths: [refreshedAllowedDir],
          },
          sandbox: {
            enabled: true,
            filesystem: {
              allowWrite: [refreshedAllowedDir],
            },
          },
        });

        const refreshed = await session.refreshRuntimeSettings();
        expect(refreshed.permissions.allowedPaths).toEqual([refreshedAllowedDir]);
        expect(refreshed.permissions.allowRules).toEqual([{ toolName: 'Write' }]);

        for await (const _message of session.send('second turn')) {
          // drain
        }

        expect(observedPolicies).toHaveLength(2);
        expect(observedPolicies[0]).toEqual(expect.arrayContaining([initialAllowedDir]));
        expect(observedPolicies[1]).toEqual(expect.arrayContaining([refreshedAllowedDir]));
        expect(observedPolicies[1]).not.toEqual(expect.arrayContaining([initialAllowedDir]));
      } finally {
        session.close();
      }
    } finally {
      cleanup();
    }
  });

  it('refreshes loop tools at turn boundaries after MCP hot reload', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-turn-boundary-tools-');
    const server = createSdkMcpServer({
      name: 'turn-boundary-server',
      tools: [
        tool(
          'echo_live',
          'Echoes text from a hot-reloaded MCP server',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => `echo:${text}`,
        ) as any,
      ],
    });

    try {
      const session = createSession({
        cwd,
        model: 'mock-model',
        provider: makeMockProvider([
          textResponse('first turn complete'),
          toolUseResponse('mcp-live-1', 'echo_live', { text: 'second turn' }),
          textResponse('second turn complete'),
        ]),
      });

      try {
        for await (const _message of session.send('first turn')) {
          // drain
        }

        const before = await session.mcpServerStatus();
        expect(before).toEqual([]);

        await session.setMcpServers({
          turn_boundary: server as any,
        });

        const secondTurnMessages: Array<{ type?: string; result?: string; is_error?: boolean }> = [];
        for await (const message of session.send('second turn')) {
          secondTurnMessages.push(message as any);
        }

        expect(secondTurnMessages.some((message) => message.type === 'result' && message.result === 'second turn complete')).toBe(true);
        expect(secondTurnMessages.some((message) => message.type === 'result' && message.is_error === true)).toBe(false);

        const after = await session.mcpServerStatus();
        expect(after[0]?.tools?.map((entry) => entry.name)).toContain('mcp__turn_boundary__echo_live');
      } finally {
        session.close();
      }
    } finally {
      cleanup();
    }
  });
});
