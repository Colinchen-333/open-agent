import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentDefinition } from '@open-agent/core';
import { ConversationLoop } from '@open-agent/core';
import { AgentRunner } from '../agent-runner.js';

// Minimal mock provider that immediately yields a text response so
// AgentRunner.run() completes in one turn without any real network call.
function makeMockProvider() {
  return {
    name: 'mock-compact-test',
    async *chat() {
      yield { type: 'text_delta', text: 'Task complete.' };
      yield {
        type: 'message_end',
        message: {},
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    },
    async listModels() {
      return [];
    },
    async getCapabilities() {
      return {
        provider: 'mock-compact-test',
        thinking: 'unsupported' as const,
        structuredOutput: 'none' as const,
        toolUse: 'native' as const,
        serverTools: 'unsupported' as const,
        supportsAdaptiveThinking: false,
        supportedEffortLevels: [] as const,
      };
    },
  };
}

const testDefinition: AgentDefinition = {
  description: 'Compact policy test agent',
  prompt: 'You are a test agent. Complete the given task.',
  name: 'compact-test-agent',
  mode: 'default',
};

describe('AgentRunner proactive compact wiring', () => {
  let capturedPolicyCalls: string[] = [];
  // Use any to avoid AutoCompactPolicy import requirement — ConversationLoop's
  // setAutoCompactPolicy is typed with that private type alias.
  let originalSetPolicy: (p: any) => void;

  beforeEach(() => {
    capturedPolicyCalls = [];
    // Spy on ConversationLoop.prototype.setAutoCompactPolicy so we can
    // verify that AgentRunner calls it with 'proactive' when creating
    // the subagent ConversationLoop.
    originalSetPolicy = ConversationLoop.prototype.setAutoCompactPolicy;
    (ConversationLoop.prototype as any).setAutoCompactPolicy = function (p: any) {
      capturedPolicyCalls.push(p as string);
      originalSetPolicy.call(this, p);
    };
  });

  afterEach(() => {
    (ConversationLoop.prototype as any).setAutoCompactPolicy = originalSetPolicy;
  });

  it('calls setAutoCompactPolicy("proactive") on the subagent ConversationLoop', async () => {
    const runner = new AgentRunner({
      definition: testDefinition,
      provider: makeMockProvider() as any,
      tools: new Map(),
      cwd: '/tmp',
      maxTurns: 1,
    });

    await runner.run('run a quick test');

    expect(capturedPolicyCalls).toContain('proactive');
  });

  it('sets proactive policy before the first turn runs', async () => {
    const policySetBeforeRun: boolean[] = [];
    let policySet = false;

    const originalSetPolicyForTiming = ConversationLoop.prototype.setAutoCompactPolicy;
    (ConversationLoop.prototype as any).setAutoCompactPolicy = function (p: any) {
      if (p === 'proactive') {
        policySet = true;
      }
      originalSetPolicyForTiming.call(this, p);
    };

    // Temporarily override run to also check the provider is called after policy set
    const originalChat = (makeMockProvider() as any).chat;
    const provider = makeMockProvider() as any;
    const originalChatMethod = provider.chat.bind(provider);
    provider.chat = async function* (...args: any[]) {
      policySetBeforeRun.push(policySet);
      yield* originalChatMethod(...args);
    };

    const runner = new AgentRunner({
      definition: testDefinition,
      provider,
      tools: new Map(),
      cwd: '/tmp',
      maxTurns: 1,
    });

    await runner.run('run a quick timing test');

    // Policy must have been set before the provider's chat() was invoked.
    expect(policySetBeforeRun.every((v) => v === true)).toBe(true);

    // Restore the extra override (afterEach will also restore, but be explicit)
    (ConversationLoop.prototype as any).setAutoCompactPolicy = originalSetPolicy;
  });
});
