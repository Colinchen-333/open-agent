import { describe, it, expect } from 'bun:test';
import { ConversationLoop } from '../conversation-loop.js';
import type { ConversationLoopOptions, PermissionChecker, PermissionPrompter } from '../conversation-loop.js';
import type { LLMProvider, Message, StreamEvent, ChatOptions } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import type { SDKMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Mock LLM provider helpers
// ---------------------------------------------------------------------------

/**
 * Build a provider whose chat() method yields the given sequence of
 * StreamEvents on the first call, then repeats the last response on
 * subsequent calls (to avoid infinite loops when testing tool flows).
 */
function makeMockProvider(
  responses: StreamEvent[][],
): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const events = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      for (const evt of events) {
        yield evt;
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
  };
}

/** Build a simple text-only response (no tool calls). */
function textResponse(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'message_end',
      message: {},
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  ];
}

function textResponseWithLegacyUsage(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'message_end',
      message: {},
      usage: { prompt_tokens: 7, completion_tokens: 11 },
    },
  ];
}

/** Build a tool_use response followed by a text response. */
function toolUseResponse(
  toolId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): StreamEvent[] {
  return [
    { type: 'tool_use_start', id: toolId, name: toolName },
    { type: 'tool_use_delta', id: toolId, partial_json: JSON.stringify(toolInput) },
    { type: 'tool_use_end', id: toolId },
    {
      type: 'message_end',
      message: {},
      usage: { input_tokens: 10, output_tokens: 30 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared option builders
// ---------------------------------------------------------------------------

function baseOptions(
  provider: LLMProvider,
  tools: ConversationLoopOptions['tools'] = new Map(),
  overrides: Partial<ConversationLoopOptions> = {},
): ConversationLoopOptions {
  return {
    provider,
    tools,
    model: 'mock-model',
    cwd: '/tmp/test',
    sessionId: 'test-session-id',
    ...overrides,
  };
}

/** Collect all SDKMessages from the async generator into an array. */
async function collectMessages(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const msg of gen) {
    out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationLoop', () => {
  describe('simple text response (no tool calls)', () => {
    it('yields: user → stream_event(s) → assistant → result', async () => {
      const provider = makeMockProvider([textResponse('Hello, world!')]);
      const loop = new ConversationLoop(baseOptions(provider));

      const messages = await collectMessages(loop.run('Hi'));

      const types = messages.map((m) => m.type);
      // Must start with user
      expect(types[0]).toBe('user');
      // Must end with result
      expect(types[types.length - 1]).toBe('result');
      // Must contain at least one stream_event
      expect(types).toContain('stream_event');
      // Must contain exactly one assistant message
      expect(types.filter((t) => t === 'assistant')).toHaveLength(1);
    });

    it('result subtype is success and is_error is false', async () => {
      const provider = makeMockProvider([textResponse('Done!')]);
      const loop = new ConversationLoop(baseOptions(provider));
      const messages = await collectMessages(loop.run('ping'));

      const result = messages.find((m) => m.type === 'result') as any;
      expect(result).toBeDefined();
      expect(result.subtype).toBe('success');
      expect(result.is_error).toBe(false);
      expect(result.result).toBe('Done!');
    });

    it('user message content matches the prompt', async () => {
      const provider = makeMockProvider([textResponse('ok')]);
      const loop = new ConversationLoop(baseOptions(provider));
      const messages = await collectMessages(loop.run('Hello test'));

      const userMsg = messages.find((m) => m.type === 'user') as any;
      expect(userMsg.message.content).toBe('Hello test');
    });

    it('normalizes legacy usage keys (prompt/completion tokens)', async () => {
      const provider = makeMockProvider([textResponseWithLegacyUsage('legacy usage')]);
      const loop = new ConversationLoop(baseOptions(provider));
      const messages = await collectMessages(loop.run('check usage'));

      const result = messages.find((m) => m.type === 'result') as any;
      expect(result).toBeDefined();
      expect(result.usage.input_tokens).toBe(7);
      expect(result.usage.output_tokens).toBe(11);
    });
  });

  describe('tool call → tool result → follow-up response', () => {
    it('executes the tool and feeds the result back to the LLM', async () => {
      const toolId = 'tool-abc-123';
      const executedWith: unknown[] = [];

      const echoTool = {
        name: 'EchoTool',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
        async execute(input: any) {
          executedWith.push(input);
          return `echo: ${input.msg}`;
        },
      };

      const provider = makeMockProvider([
        // First call: tool use
        toolUseResponse(toolId, 'EchoTool', { msg: 'hello' }),
        // Second call: plain text (no more tool calls)
        textResponse('Done calling echo tool.'),
      ]);

      const tools = new Map([['EchoTool', echoTool]]);
      const loop = new ConversationLoop(baseOptions(provider, tools));
      const messages = await collectMessages(loop.run('call echo'));

      // Tool was executed with the correct input
      expect(executedWith).toHaveLength(1);
      expect((executedWith[0] as any).msg).toBe('hello');

      // A tool_result SDKMessage should appear in the stream
      const toolResult = messages.find((m) => m.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.tool_name).toBe('EchoTool');
      expect(toolResult.is_error).toBe(false);
      expect(toolResult.result).toContain('echo: hello');

      // Final result should be success
      const result = messages.find((m) => m.type === 'result') as any;
      expect(result.subtype).toBe('success');
    });

    it('unknown tool feeds an error back to the LLM and the loop continues to success', async () => {
      const toolId = 'bad-tool-id';
      const provider = makeMockProvider([
        // First call: unknown tool use
        toolUseResponse(toolId, 'NonExistentTool', { x: 1 }),
        // Second call: follow-up text reply (no more tool calls)
        textResponse('Sorry, that tool is unknown.'),
      ]);

      const loop = new ConversationLoop(baseOptions(provider));
      const messages = await collectMessages(loop.run('use unknown tool'));

      // The loop should complete with success — the error is fed back to the LLM
      // as a tool_result content block (internal), not as a top-level SDK message.
      const result = messages.find((m) => m.type === 'result') as any;
      expect(result).toBeDefined();
      expect(result.subtype).toBe('success');
      // The second LLM call received the error and replied with text.
      expect(result.result).toBe('Sorry, that tool is unknown.');
    });
  });

  describe('maxTurns limit', () => {
    it('yields error_max_turns result when maxTurns is exceeded', async () => {
      // Provide a tool-use response that repeats infinitely — maxTurns should stop it.
      const infiniteTool = {
        name: 'InfiniteTool',
        description: 'Loops forever',
        inputSchema: { type: 'object', properties: {} },
        async execute() { return 'still going'; },
      };

      // Always return a tool call so the loop never resolves naturally.
      const provider = makeMockProvider([
        toolUseResponse('t1', 'InfiniteTool', {}),
      ]);

      const tools = new Map([['InfiniteTool', infiniteTool]]);
      const loop = new ConversationLoop(baseOptions(provider, tools, { maxTurns: 1 }));
      const messages = await collectMessages(loop.run('go infinite'));

      const result = messages.find((m) => m.type === 'result') as any;
      expect(result).toBeDefined();
      expect(result.subtype).toBe('error_max_turns');
      expect(result.is_error).toBe(true);
      expect(result.stop_reason).toBe('max_turns');
    });
  });

  describe('permission denial flow', () => {
    it('denies a tool and emits a tool_result with is_error=true', async () => {
      const toolId = 'perm-tool-id';
      const blockedTool = {
        name: 'BlockedTool',
        description: 'Blocked',
        inputSchema: { type: 'object', properties: {} },
        async execute() { return 'executed'; },
      };

      // Permission engine that always denies.
      const denyEngine: PermissionChecker = {
        evaluate: () => ({ behavior: 'deny', reason: 'test deny' }),
        addRule: () => {},
      };

      const provider = makeMockProvider([
        toolUseResponse(toolId, 'BlockedTool', {}),
        textResponse('The tool was denied.'),
      ]);

      const tools = new Map([['BlockedTool', blockedTool]]);
      const loop = new ConversationLoop(
        baseOptions(provider, tools, { permissionEngine: denyEngine }),
      );
      const messages = await collectMessages(loop.run('try blocked tool'));

      const toolResult = messages.find((m) => m.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.result).toContain('Permission denied');

      const result = messages.find((m) => m.type === 'result') as any;
      expect(result.subtype).toBe('success');
      // The denial should be reflected in permission_denials on the result
      expect(result.permission_denials).toHaveLength(1);
      expect(result.permission_denials[0]).toContain('BlockedTool');
    });

    it('ask behavior with user denying emits denial and continues', async () => {
      const toolId = 'ask-tool-id';
      const askTool = {
        name: 'AskTool',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        async execute() { return 'executed'; },
      };

      const askEngine: PermissionChecker = {
        evaluate: () => ({ behavior: 'ask', reason: 'needs approval' }),
        addRule: () => {},
      };

      const denyPrompter: PermissionPrompter = {
        async prompt() { return 'deny'; },
      };

      const provider = makeMockProvider([
        toolUseResponse(toolId, 'AskTool', {}),
        textResponse('User denied.'),
      ]);

      const tools = new Map([['AskTool', askTool]]);
      const loop = new ConversationLoop(
        baseOptions(provider, tools, {
          permissionEngine: askEngine,
          permissionPrompter: denyPrompter,
        }),
      );
      const messages = await collectMessages(loop.run('run ask tool'));

      const toolResult = messages.find((m) => m.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.result).toContain('Permission denied');
    });

    it('ask behavior with always approval adds allow rule and proceeds', async () => {
      const toolId = 'always-tool-id';
      const addedRules: Array<{ behavior: string; rule: any }> = [];

      const alwaysTool = {
        name: 'AlwaysTool',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        async execute() { return 'executed successfully'; },
      };

      const askEngine: PermissionChecker = {
        evaluate: () => ({ behavior: 'ask', reason: 'needs approval' }),
        addRule: (behavior, rule) => { addedRules.push({ behavior, rule }); },
      };

      const alwaysPrompter: PermissionPrompter = {
        async prompt() { return 'always'; },
      };

      const provider = makeMockProvider([
        toolUseResponse(toolId, 'AlwaysTool', {}),
        textResponse('All done.'),
      ]);

      const tools = new Map([['AlwaysTool', alwaysTool]]);
      const loop = new ConversationLoop(
        baseOptions(provider, tools, {
          permissionEngine: askEngine,
          permissionPrompter: alwaysPrompter,
        }),
      );
      const messages = await collectMessages(loop.run('run always tool'));

      // An allow rule should have been added for this tool.
      expect(addedRules).toHaveLength(1);
      expect(addedRules[0].behavior).toBe('allow');
      expect(addedRules[0].rule.toolName).toBe('AlwaysTool');

      // Tool should have been executed (not denied).
      const toolResult = messages.find((m) => m.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBe(false);
    });
  });

  describe('initialMessages are preserved', () => {
    it('starts conversation with pre-populated history', async () => {
      const provider = makeMockProvider([textResponse('Continuing!')]);

      const initialMessages: Message[] = [
        { role: 'user', content: 'previous question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
        },
      ];

      const loop = new ConversationLoop(
        baseOptions(provider, new Map(), { initialMessages }),
      );

      // The messages history should include the initial messages before the run.
      const historySpy = loop.getMessages();
      expect(historySpy).toHaveLength(2);
      expect(historySpy[0].role).toBe('user');
      expect(historySpy[1].role).toBe('assistant');

      // Running a new prompt should append to the existing history.
      await collectMessages(loop.run('follow-up question'));

      const finalHistory = loop.getMessages();
      // initial (2) + new user (1) + new assistant (1) = 4
      expect(finalHistory.length).toBeGreaterThanOrEqual(3);
      expect(finalHistory[0].content).toBe('previous question');
    });
  });

  describe('abort signal', () => {
    it('stops early when abort signal fires and yields interrupted result', async () => {
      const controller = new AbortController();

      // Create a provider that aborts mid-stream.
      const abortingProvider: LLMProvider = {
        name: 'aborting-mock',
        async *chat() {
          yield { type: 'text_delta', text: 'Starting...' } as StreamEvent;
          // Abort mid-stream before finishing.
          controller.abort();
          yield { type: 'text_delta', text: 'More text' } as StreamEvent;
          yield {
            type: 'message_end',
            message: {},
            usage: { input_tokens: 5, output_tokens: 5 },
          } as StreamEvent;
        },
        async listModels() { return []; },
      };

      const loop = new ConversationLoop(
        baseOptions(abortingProvider, new Map(), { abortSignal: controller.signal }),
      );

      const messages = await collectMessages(loop.run('start'));

      const result = messages.find((m) => m.type === 'result') as any;
      expect(result).toBeDefined();
      expect(result.is_error).toBe(true);
      expect(result.stop_reason).toBe('interrupted');
    });
  });

  describe('getTurnCount', () => {
    it('increments turn count with each LLM call', async () => {
      const echoTool = {
        name: 'EchoTool',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
        async execute(input: any) { return `echo: ${input.msg}`; },
      };

      const provider = makeMockProvider([
        toolUseResponse('t1', 'EchoTool', { msg: 'hello' }),
        textResponse('Done.'),
      ]);

      const tools = new Map([['EchoTool', echoTool]]);
      const loop = new ConversationLoop(baseOptions(provider, tools));
      await collectMessages(loop.run('go'));

      // 2 LLM calls: first returned tool_use, second returned text.
      expect(loop.getTurnCount()).toBe(2);
    });
  });
});
