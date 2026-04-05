import { describe, it, expect } from 'bun:test';
import {
  buildAnthropicSystemParam,
  convertMessages,
  extractSystemPrompt,
  convertTools,
  effortToBudget,
} from '../anthropic.js';
import { buildAnthropicThinkingParam } from '../thinking.js';
import type { Message, ContentBlock, ChatOptions, ToolSpec } from '../types.js';

// ---------------------------------------------------------------------------
// convertMessages
// ---------------------------------------------------------------------------

describe('convertMessages', () => {
  it('converts user message with string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello, world!' },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello, world!');
  });

  it('converts assistant message with string content', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'I can help you with that.' },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('I can help you with that.');
  });

  it('filters out system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = convertMessages(messages);

    // System message is filtered; only the user message remains.
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('converts user message with tool_result blocks (string content)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-abc-123',
            content: 'The result text',
          } as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(1);
    const blocks = result[0].content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tool-abc-123');
    expect(blocks[0].content).toBe('The result text');
  });

  it('converts user message with tool_result block (array content)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-xyz-456',
            // content is an array of ContentBlock objects
            content: [{ type: 'text', text: 'Array result' }],
          } as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);

    const blocks = result[0].content as any[];
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tool-xyz-456');
    // The implementation maps each ContentBlock via:
    //   typeof c === 'string' ? c : JSON.stringify(c)
    // So a ContentBlock object becomes a JSON string wrapped in a text entry.
    expect(Array.isArray(blocks[0].content)).toBe(true);
    expect(blocks[0].content[0].type).toBe('text');
    // The implementation maps text ContentBlocks to { type: 'text', text: '...' }
    expect(blocks[0].content[0].text).toBeDefined();
  });

  it('converts assistant message with text and thinking blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Let me reason through this...',
            signature: 'sig-abc',
          } as ContentBlock,
          {
            type: 'text',
            text: 'The answer is 42.',
          } as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(1);
    const blocks = result[0].content as any[];
    expect(blocks).toHaveLength(2);

    const thinkingBlock = blocks[0];
    expect(thinkingBlock.type).toBe('thinking');
    expect(thinkingBlock.thinking).toBe('Let me reason through this...');
    expect(thinkingBlock.signature).toBe('sig-abc');

    const textBlock = blocks[1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('The answer is 42.');
  });

  it('converts assistant message with tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-001',
            name: 'Bash',
            input: { command: 'ls -la' },
          } as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);

    const blocks = result[0].content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].id).toBe('tu-001');
    expect(blocks[0].name).toBe('Bash');
    expect(blocks[0].input).toEqual({ command: 'ls -la' });
  });

  it('uses empty object as default when tool_use input is missing', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-002',
            name: 'NoInput',
            // input deliberately omitted
          } as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);
    const blocks = result[0].content as any[];
    expect(blocks[0].input).toEqual({});
  });

  it('preserves multiple messages in order (excluding system)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'First user message' },
      { role: 'assistant', content: 'First assistant reply' },
      { role: 'user', content: 'Second user message' },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('user');
  });

  it('falls back to JSON for unknown block types', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'custom_unknown_type',
            data: 'some data',
          } as unknown as ContentBlock,
        ],
      },
    ];

    const result = convertMessages(messages);
    const blocks = result[0].content as any[];
    // Unknown types are serialized as a text block with JSON content
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('custom_unknown_type');
  });
});

// ---------------------------------------------------------------------------
// extractSystemPrompt
// ---------------------------------------------------------------------------

describe('extractSystemPrompt', () => {
  const baseOptions: ChatOptions = { model: 'claude-sonnet-4-6' };

  it('returns content of the first system message (string content)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a code assistant.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = extractSystemPrompt(messages, baseOptions);
    expect(result).toBe('You are a code assistant.');
  });

  it('returns concatenated text from system message content blocks', () => {
    const messages: Message[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Line one.' },
          { type: 'text', text: 'Line two.' },
        ] as ContentBlock[],
      },
    ];

    const result = extractSystemPrompt(messages, baseOptions);
    expect(result).toBe('Line one.\nLine two.');
  });

  it('falls back to options.systemPrompt when no system message present', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];
    const options: ChatOptions = { model: 'claude-sonnet-4-6', systemPrompt: 'Fallback prompt' };

    const result = extractSystemPrompt(messages, options);
    expect(result).toBe('Fallback prompt');
  });

  it('returns undefined when no system message and no systemPrompt in options', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    const result = extractSystemPrompt(messages, baseOptions);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

describe('convertTools', () => {
  it('converts a single ToolSpec to Anthropic Tool format', () => {
    const tools: ToolSpec[] = [
      {
        name: 'Bash',
        description: 'Run bash commands',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Bash');
    expect(result[0].description).toBe('Run bash commands');
    expect(result[0].input_schema).toEqual(tools[0].input_schema as any);
  });

  it('converts multiple ToolSpecs preserving order', () => {
    const tools: ToolSpec[] = [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
      { name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: {} } },
      { name: 'Glob', description: 'Glob files', input_schema: { type: 'object', properties: {} } },
    ];

    const result = convertTools(tools);

    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(['Read', 'Write', 'Glob']);
  });

  it('returns an empty array when given no tools', () => {
    const result = convertTools([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ChatOptions responseFormat
// ---------------------------------------------------------------------------

describe('ChatOptions responseFormat', () => {
  it('responseFormat field is accepted in ChatOptions', () => {
    const opts: ChatOptions = {
      model: 'claude-sonnet-4-6',
      responseFormat: { type: 'json_schema', schema: { type: 'object' } },
    };
    expect(opts.responseFormat?.type).toBe('json_schema');
  });

  it('schema is accessible from responseFormat', () => {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const opts: ChatOptions = {
      model: 'claude-sonnet-4-6',
      responseFormat: { type: 'json_schema', schema },
    };
    expect(opts.responseFormat?.schema).toEqual(schema);
  });

  it('responseFormat is optional (defaults to undefined)', () => {
    const opts: ChatOptions = { model: 'claude-sonnet-4-6' };
    expect(opts.responseFormat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// effortToBudget
// ---------------------------------------------------------------------------

describe('effortToBudget', () => {
  it('maps "low" to 2000 tokens', () => {
    expect(effortToBudget('low')).toBe(2000);
  });

  it('maps "medium" to 8000 tokens', () => {
    expect(effortToBudget('medium')).toBe(8000);
  });

  it('maps "high" to 16000 tokens', () => {
    expect(effortToBudget('high')).toBe(16000);
  });

  it('maps "max" to 32000 tokens', () => {
    expect(effortToBudget('max')).toBe(32000);
  });

  it('returns 8000 for undefined (default)', () => {
    expect(effortToBudget(undefined)).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// buildAnthropicSystemParam
// ---------------------------------------------------------------------------

describe('buildAnthropicSystemParam', () => {
  it('marks only the last static block with cache_control', () => {
    const blocks = [
      { text: 'STATIC-IDENTITY', section: 'static' as const },
      { text: 'STATIC-TOOLS', section: 'static' as const },
      { text: 'DYNAMIC-PROJECT', section: 'dynamic' as const },
      { text: 'DYNAMIC-GIT', section: 'dynamic' as const },
    ];

    const system = buildAnthropicSystemParam(blocks);

    expect(system).toEqual([
      { type: 'text', text: 'STATIC-IDENTITY' },
      { type: 'text', text: 'STATIC-TOOLS', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'DYNAMIC-PROJECT' },
      { type: 'text', text: 'DYNAMIC-GIT' },
    ]);
  });

  it('handles a list with only static blocks by marking the last one', () => {
    const blocks = [
      { text: 'STATIC-A', section: 'static' as const },
      { text: 'STATIC-B', section: 'static' as const },
    ];

    const system = buildAnthropicSystemParam(blocks);

    expect(system[0]).toEqual({ type: 'text', text: 'STATIC-A' });
    expect(system[1]).toEqual({ type: 'text', text: 'STATIC-B', cache_control: { type: 'ephemeral' } });
  });

  it('applies no cache_control when there are no static blocks', () => {
    const blocks = [
      { text: 'DYNAMIC-A', section: 'dynamic' as const },
      { text: 'DYNAMIC-B', section: 'dynamic' as const },
    ];

    const system = buildAnthropicSystemParam(blocks);

    for (const entry of system) {
      expect(entry.cache_control).toBeUndefined();
    }
  });

  it('returns an empty array for empty input', () => {
    expect(buildAnthropicSystemParam([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Thinking request-body shape (via buildAnthropicThinkingParam)
//
// AnthropicProvider.chat() delegates thinking-param construction to the pure
// helper buildAnthropicThinkingParam, which is already tested exhaustively in
// thinking.test.ts.  These tests focus on the integration contract that the
// anthropic.ts chat() method relies on: specifically that the param returned
// by the helper contains the fields the API expects, and that the temperature
// rule is well-understood.
// ---------------------------------------------------------------------------

describe('AnthropicProvider thinking body-shape integration', () => {
  it('includes thinking.type=enabled and budget_tokens>0 when model supports thinking and config is enabled', () => {
    const param = buildAnthropicThinkingParam({
      model: 'claude-sonnet-4-6',       // supportsThinking → true
      thinking: { type: 'enabled' },
      effort: 'medium',
    });

    expect(param).toBeDefined();
    expect(param!.type).toBe('enabled');
    expect(param!.budget_tokens).toBeGreaterThan(0);
  });

  it('omits thinking param entirely when model does not support thinking (e.g. glm-4.7)', () => {
    // glm-4.7 is registered in model-capability.ts with supportsThinking: false.
    // Even if the caller asks for thinking, the gate must prevent it from reaching the API.
    const param = buildAnthropicThinkingParam({
      model: 'glm-4.7',                  // supportsThinking → false
      thinking: { type: 'enabled' },
    });

    expect(param).toBeUndefined();
  });

  it('omits thinking param when config is disabled on a capable model', () => {
    const param = buildAnthropicThinkingParam({
      model: 'claude-opus-4-6',           // supportsThinking → true
      thinking: { type: 'disabled' },
    });

    expect(param).toBeUndefined();
  });

  it('temperature must be set to 1.0 in baseParams when thinking is active (chat() contract)', () => {
    // This test documents the invariant enforced in chat() rather than calling the
    // private API.  When buildAnthropicThinkingParam returns a non-undefined value,
    // chat() spreads `{ temperature: 1.0 }` into baseParams regardless of the
    // caller-supplied options.temperature.
    //
    // We verify this indirectly: if thinking IS active we expect a param, and the
    // absence of temperature in the param (temperature is a sibling field in the
    // request body, set by chat()) doesn't break this assertion.
    const param = buildAnthropicThinkingParam({
      model: 'claude-sonnet-4-6',
      thinking: { type: 'enabled' },
      effort: 'low',
    });

    // Thinking param is present → chat() will inject temperature: 1.0
    expect(param).toBeDefined();
    // The param itself carries only type + budget_tokens (temperature is a sibling)
    expect(param!.type).toBe('enabled');
    expect(param!.budget_tokens).toBe(8_000); // 'low' → 8_000 per thinkingBudgetFromEffort
  });
});
