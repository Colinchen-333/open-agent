/**
 * R9 — Fork isolation gap closure: AgentDefinition type-level tests
 *
 * Verifies that AgentDefinition.isolation accepts 'fork' as a valid value
 * alongside the pre-existing 'worktree' and 'none' variants.
 */
import { describe, it, expect } from 'bun:test';
import type { AgentDefinition } from '../types.js';

describe('AgentDefinition isolation union', () => {
  it("accepts isolation: 'fork'", () => {
    const def: AgentDefinition = {
      name: 'test-fork-agent',
      description: 'Agent used to verify fork isolation type',
      prompt: 'Do nothing.',
      isolation: 'fork',
    };
    expect(def.isolation).toBe('fork');
  });

  it("accepts isolation: 'worktree'", () => {
    const def: AgentDefinition = {
      name: 'test-worktree-agent',
      description: 'Agent used to verify worktree isolation type',
      prompt: 'Do nothing.',
      isolation: 'worktree',
    };
    expect(def.isolation).toBe('worktree');
  });

  it("accepts isolation: 'none'", () => {
    const def: AgentDefinition = {
      name: 'test-none-agent',
      description: 'Agent used to verify none isolation type',
      prompt: 'Do nothing.',
      isolation: 'none',
    };
    expect(def.isolation).toBe('none');
  });

  it('accepts missing isolation (undefined)', () => {
    const def: AgentDefinition = {
      name: 'test-default-agent',
      description: 'Agent with no isolation specified',
      prompt: 'Do nothing.',
    };
    expect(def.isolation).toBeUndefined();
  });
});
