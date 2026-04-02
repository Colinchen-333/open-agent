import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SDKMessage } from '@open-agent/core';
import type { LLMProvider, Message, StreamEvent, ChatOptions } from '@open-agent/providers';

let providerFactory: (() => LLMProvider) | null = null;

mock.module('@open-agent/providers', () => ({
  autoDetectProvider: () => {
    if (!providerFactory) {
      throw new Error('No mock provider configured for orchestration event test.');
    }
    return providerFactory();
  },
  createProvider: () => {
    if (!providerFactory) {
      throw new Error('No mock provider configured for orchestration event test.');
    }
    return providerFactory();
  },
  calculateCost: () => 0,
}));

const { query } = await import('../query.js');

function makeTempCwd(prefix: string): { cwd: string; cleanup(): void } {
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

function makeScriptedProvider(scripts: StreamEvent[][]): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-orchestration',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const script = scripts[callIndex];
      callIndex += 1;
      if (!script) {
        throw new Error(`No mock script configured for provider call ${callIndex}.`);
      }
      for (const event of script) {
        yield event;
      }
    },
    async listModels() {
      return [];
    },
  };
}

function toolUseScript(toolName: string, input: Record<string, unknown>, id: string): StreamEvent[] {
  return [
    { type: 'tool_use_start', id, name: toolName } as StreamEvent,
    { type: 'tool_use_delta', id, partial_json: JSON.stringify(input) } as StreamEvent,
    { type: 'tool_use_end', id } as StreamEvent,
    {
      type: 'message_end',
      message: {},
      usage: { input_tokens: 10, output_tokens: 5 },
    } as StreamEvent,
  ];
}

function textScript(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text } as StreamEvent,
    {
      type: 'message_end',
      message: {},
      usage: { input_tokens: 10, output_tokens: 5 },
    } as StreamEvent,
  ];
}

async function drainQuery(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of gen) {
    messages.push(message);
  }
  return messages;
}

describe('query().subscribeOrchestrationEvents()', () => {
  it('streams live worker lifecycle events with type and team filtering', async () => {
    const temp = makeTempCwd('open-agent-sdk-orchestration-lifecycle-');
    providerFactory = () => makeScriptedProvider([
      toolUseScript('Task', {
        description: 'Launch worker',
        prompt: 'Finish the task and report back.',
        subagent_type: 'general-purpose',
        team_name: 'alpha-team',
      }, 'task-parent-1'),
      textScript('worker complete'),
      textScript('parent complete'),
    ]);

    try {
      const q = query('launch a worker', {
        cwd: temp.cwd,
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });
      const iterator = q.subscribeOrchestrationEvents({
        types: ['worker_lifecycle'],
        teamName: 'alpha-team',
      })[Symbol.asyncIterator]();

      const runPromise = drainQuery(q);
      const launched = await iterator.next();
      const completed = await iterator.next();
      const messages = await runPromise;

      expect(launched.done).toBe(false);
      expect(launched.value.kind).toBe('worker_lifecycle');
      expect(launched.value.parentToolCallId).toBe('task-parent-1');
      expect(launched.value.teamName).toBe('alpha-team');
      expect(launched.value.raw.type).toBe('launched');

      expect(completed.done).toBe(false);
      expect(completed.value.kind).toBe('worker_lifecycle');
      expect(completed.value.parentToolCallId).toBe('task-parent-1');
      expect(completed.value.teamName).toBe('alpha-team');
      expect(completed.value.raw.type).toBe('completed');
      expect(completed.value.workerId).toBe(launched.value.workerId);

      const result = messages.find((message) => message.type === 'result') as any;
      expect(result?.subtype).toBe('success');
      expect((await iterator.next()).done).toBe(true);
      q.close();
    } finally {
      providerFactory = null;
      temp.cleanup();
    }
  });

  it('streams live worker tool events and closes on AbortSignal', async () => {
    const temp = makeTempCwd('open-agent-sdk-orchestration-tools-');
    providerFactory = () => makeScriptedProvider([
      toolUseScript('Task', {
        description: 'Launch tool-using worker',
        prompt: 'Use EchoTool once and then finish.',
        subagent_type: 'general-purpose',
        team_name: 'alpha-team',
      }, 'task-parent-2'),
      toolUseScript('EchoTool', { text: 'hello from worker' }, 'worker-tool-1'),
      textScript('worker complete'),
      textScript('parent complete'),
    ]);

    try {
      const q = query('launch a worker that uses a tool', {
        cwd: temp.cwd,
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        setupTools: (registry) => {
          registry.register({
            name: 'EchoTool',
            description: 'Echo the provided text.',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string' },
              },
              required: ['text'],
            },
            execute: async (input) => JSON.stringify({ echoed: input.text ?? '' }),
          });
        },
      });
      const controller = new AbortController();
      const iterator = q.subscribeOrchestrationEvents({
        types: ['worker_tool'],
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const runPromise = drainQuery(q);
      const first = await iterator.next();
      const second = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value.kind).toBe('worker_tool');
      expect(first.value.parentToolCallId).toBe('task-parent-2');
      expect(first.value.raw.type).toBe('tool_start');
      expect(first.value.raw.toolName).toBe('EchoTool');

      expect(second.done).toBe(false);
      expect(second.value.kind).toBe('worker_tool');
      expect(second.value.raw.type).toBe('tool_result');
      expect(second.value.raw.toolName).toBe('EchoTool');

      controller.abort();
      expect((await iterator.next()).done).toBe(true);
      await runPromise;
      q.close();
    } finally {
      providerFactory = null;
      temp.cleanup();
    }
  });

  it('closes the event stream when query.close() is called', async () => {
    providerFactory = () => makeScriptedProvider([textScript('unused')]);
    const source = (async function* () {})();
    const q = query({
      prompt: source,
      options: {
        model: 'claude-sonnet-4-6',
        idleOnPromptExhaustion: true,
      },
    });
    const iterator = q.subscribeOrchestrationEvents()[Symbol.asyncIterator]();

    q.close();
    expect((await iterator.next()).done).toBe(true);
  });

  it('streams task dispatcher events through the same orchestration channel', async () => {
    const temp = makeTempCwd('open-agent-sdk-orchestration-dispatcher-');
    providerFactory = () => makeScriptedProvider([
      textScript('dispatcher worker complete'),
    ]);

    try {
      const teamName = `alpha-team-${Date.now()}`;
      const q = query('dispatcher orchestration', {
        cwd: temp.cwd,
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });
      await q.createTeam({ name: teamName, setActive: true });
      await q.createTask({
        teamName,
        subject: 'Ship dispatcher event stream',
        description: 'Ensure dispatcher emits host-visible orchestration events.',
        priority: 10,
      });

      const iterator = q.subscribeOrchestrationEvents({
        types: ['task_dispatcher'],
        teamName,
      })[Symbol.asyncIterator]();

      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
      });

      const started = await iterator.next();
      const dispatched = await iterator.next();
      const settled = await iterator.next();

      expect(started.done).toBe(false);
      expect(started.value.kind).toBe('task_dispatcher');
      expect(started.value.dispatcherId).toBe(dispatcher.dispatcherId);
      expect(started.value.dispatcherEvent?.type).toBe('started');

      expect(dispatched.done).toBe(false);
      expect(dispatched.value.kind).toBe('task_dispatcher');
      expect(dispatched.value.dispatcherEvent?.type).toBe('dispatched');
      expect(dispatched.value.dispatcherEvent?.taskId).toBeTruthy();
      expect(dispatched.value.dispatcherEvent?.workerId).toBeTruthy();

      expect(settled.done).toBe(false);
      expect(settled.value.kind).toBe('task_dispatcher');
      expect(settled.value.dispatcherEvent?.type).toBe('task_completed');
      expect(settled.value.dispatcherEvent?.taskStatus).toBe('completed');

      await expect(q.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
      });
      const stopped = await iterator.next();
      expect(stopped.done).toBe(false);
      expect(stopped.value.dispatcherEvent?.type).toBe('stopped');
      expect(stopped.value.dispatcherEvent?.status).toBe('stopped');

      await iterator.return?.();
      q.close();
    } finally {
      providerFactory = null;
      temp.cleanup();
    }
  });
});
