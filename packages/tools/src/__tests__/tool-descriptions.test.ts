import { describe, expect, it } from 'bun:test';
import { getToolPromptDescriptions } from '../tool-descriptions.js';

describe('tool prompt descriptions', () => {
  it('documents verifier-oriented task orchestration', () => {
    const descriptions = getToolPromptDescriptions();

    expect(descriptions.Task).toContain('verifier (clean-slate validation)');
    expect(descriptions.Task).toContain('prefer launching a fresh verifier');
    expect(descriptions.Task).toContain('do not just say "review this"');
    expect(descriptions.Task).toContain('orchestration prompt templates');
  });

  it('documents concrete verification handoffs for SendMessage', () => {
    const descriptions = getToolPromptDescriptions();

    expect(descriptions.SendMessage).toContain('fresh verifier teammate');
    expect(descriptions.SendMessage).toContain('exact claims to verify');
    expect(descriptions.SendMessage).toContain('observed failure chain');
  });
});
