/**
 * Tests verifying that hookExecutor and llmProvider are properly wired through
 * the effectivePermissionEngine wrapper to the underlying PermissionEngine in
 * the SDK query path (Lane B2 fix).
 *
 * These tests use the PermissionEngine directly to validate the wiring
 * contract without the full query() overhead.
 */

import { describe, it, expect } from 'bun:test';
import { PermissionEngine } from '@open-agent/permissions';

describe('SDK permission engine hook/provider wiring', () => {
  it('setHookExecutor stores executor on PermissionEngine instance', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const calls: string[] = [];
    engine.setHookExecutor({
      async run(event) {
        calls.push(event);
        return {};
      },
    });
    // Verify the executor is accessible for the pipeline stage.
    expect(typeof (engine as any).hookExecutor).toBe('object');
    expect(typeof (engine as any).hookExecutor.run).toBe('function');
  });

  it('setLLMProvider stores provider on PermissionEngine instance', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const fakeProvider = { async classify(_: string) { return 'APPROVE'; } };
    engine.setLLMProvider(fakeProvider);
    expect((engine as any).llmProvider).toBe(fakeProvider);
  });

  it('setRecentUserMessages populates the transcript on the engine', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    engine.setRecentUserMessages(['first message', 'second message']);
    expect((engine as any).recentUserMessages).toEqual(['first message', 'second message']);
  });

  it('hookExecutor survives a simulated engine rebuild (re-apply pattern)', () => {
    // Simulate the SDK rebuildPermissionEngine re-apply pattern:
    // store the executor in a closure variable and apply it to each new engine.
    let storedExecutor: { run(event: string, input: unknown): Promise<any> } | undefined;

    const buildEngine = (): PermissionEngine => {
      const engine = new PermissionEngine({ mode: 'default' });
      if (storedExecutor) engine.setHookExecutor(storedExecutor);
      return engine;
    };

    let engine = buildEngine();
    expect((engine as any).hookExecutor).toBeUndefined();

    // Wire the executor.
    storedExecutor = { async run() { return {}; } };
    engine.setHookExecutor(storedExecutor);

    // Simulate a settings-triggered rebuild.
    engine = buildEngine();
    expect((engine as any).hookExecutor).toBe(storedExecutor);
  });

  it('llmProvider survives a simulated engine rebuild (re-apply pattern)', () => {
    let storedProvider: { classify(prompt: string): Promise<string> } | undefined;

    const buildEngine = (): PermissionEngine => {
      const engine = new PermissionEngine({ mode: 'default' });
      if (storedProvider) engine.setLLMProvider(storedProvider);
      return engine;
    };

    let engine = buildEngine();
    expect((engine as any).llmProvider).toBeUndefined();

    storedProvider = { async classify(_: string) { return 'DENY'; } };
    engine.setLLMProvider(storedProvider);

    engine = buildEngine();
    expect((engine as any).llmProvider).toBe(storedProvider);
  });

  it('effectivePermissionEngine wrapper delegates setRecentUserMessages to the live engine', () => {
    // Simulate the wrapper pattern used in query.ts: a mutable `permissionEngine`
    // reference inside a closure, and a wrapper object that delegates to it.
    let permissionEngine: PermissionEngine = new PermissionEngine({ mode: 'default' });

    const effectivePermissionEngine = {
      setRecentUserMessages: (messages: string[]) => {
        permissionEngine.setRecentUserMessages(messages);
      },
    };

    effectivePermissionEngine.setRecentUserMessages(['hello world']);
    expect((permissionEngine as any).recentUserMessages).toEqual(['hello world']);

    // After rebuild, the wrapper now points at the new engine.
    permissionEngine = new PermissionEngine({ mode: 'default' });
    effectivePermissionEngine.setRecentUserMessages(['post-rebuild message']);
    expect((permissionEngine as any).recentUserMessages).toEqual(['post-rebuild message']);
  });
});
