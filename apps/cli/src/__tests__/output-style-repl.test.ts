/**
 * Integration test for R6.1 — /output-style REPL persistence
 *
 * Verifies that:
 *   1. The SlashCommandContext built in the REPL provides setOutputStyleName.
 *   2. handleSlashCommand('/output-style <name>', ctx) calls the callback.
 *   3. A hypothetical query-options builder sees the resolved OutputStyle
 *      stored by the callback.
 */
import { describe, expect, it } from 'bun:test';
import { handleSlashCommand } from '@open-agent/cli';
import { mergeOutputStyles, findOutputStyle, BUILTIN_OUTPUT_STYLES } from '@open-agent/core';
import type { OutputStyle } from '@open-agent/core';

// ---------------------------------------------------------------------------
// Minimal SlashCommandContext factory — mirrors index.ts construction.
// ---------------------------------------------------------------------------

function makeReplContext(
  setOutputStyleName: (name: string) => void,
  overrides: Record<string, unknown> = {},
) {
  return {
    loop: {} as any,
    cwd: '/tmp/test-project',
    model: 'test-model',
    sessionId: 'sess-r6',
    tools: [],
    capabilities: {} as any,
    checkpoint: {} as any,
    sessionMgr: {} as any,
    permissionMode: 'default' as const,
    thinking: 'disabled' as const,
    effort: undefined,
    agentTypes: [],
    skills: [],
    mcpStatus: [],
    permissionEngine: {} as any,
    listBackgroundAgents: () => [],
    getBackgroundAgent: async () => undefined,
    stopBackgroundAgent: async () => {},
    setOutputStyleName,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Simulates the index.ts callback: resolves an OutputStyle and writes the
// result into a closure variable (parallel to activeCliOutputStyle).
// ---------------------------------------------------------------------------

function makeStyleSetter(): {
  activeCliOutputStyle: Pick<OutputStyle, 'name' | 'instructions' | 'keepCodingInstructions'> | undefined;
  setOutputStyleName: (name: string) => void;
} {
  let activeCliOutputStyle: Pick<OutputStyle, 'name' | 'instructions' | 'keepCodingInstructions'> | undefined = undefined;

  const setOutputStyleName = (name: string): void => {
    // Synchronous resolution using only builtins — mirrors the async path in
    // index.ts but without filesystem I/O so tests run fast and deterministic.
    const all = mergeOutputStyles([], BUILTIN_OUTPUT_STYLES);
    activeCliOutputStyle = findOutputStyle(name, all);
  };

  return {
    get activeCliOutputStyle() {
      return activeCliOutputStyle;
    },
    setOutputStyleName,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REPL /output-style wiring (R6.1)', () => {
  it('setOutputStyleName callback is invoked when /output-style verbose is run', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    const result = await handleSlashCommand('/output-style verbose', ctx as any);

    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('verbose');
    // The callback must have been called — activeCliOutputStyle is now populated.
    expect(setter.activeCliOutputStyle).not.toBeUndefined();
    expect(setter.activeCliOutputStyle?.name).toBe('verbose');
  });

  it('output message does NOT contain "effect on next query" when callback is wired', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    const result = await handleSlashCommand('/output-style terse', ctx as any);

    expect(result?.output).not.toContain('effect on next query');
  });

  it('resolved style object carries the expected instructions for the query builder', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    await handleSlashCommand('/output-style terse', ctx as any);

    // The query builder in buildCliSystemPrompt reads activeCliOutputStyle.
    // Verify it contains non-empty instructions (terse is code-first).
    const style = setter.activeCliOutputStyle;
    expect(style).not.toBeUndefined();
    expect(style!.name).toBe('terse');
    expect(typeof style!.instructions).toBe('string');
    expect(style!.instructions.length).toBeGreaterThan(0);
  });

  it('aliased /style command also triggers the callback', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    const result = await handleSlashCommand('/style verbose', ctx as any);

    expect(result?.handled).toBe(true);
    expect(setter.activeCliOutputStyle?.name).toBe('verbose');
  });

  it('aliased /outputstyle command also triggers the callback', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    const result = await handleSlashCommand('/outputstyle terse', ctx as any);

    expect(result?.handled).toBe(true);
    expect(setter.activeCliOutputStyle?.name).toBe('terse');
  });

  it('query options builder sees non-undefined activeOutputStyle after callback fires', () => {
    const setter = makeStyleSetter();
    // Simulate what buildCliSystemPrompt closure reads.
    const buildQueryOptions = () => ({
      outputStyle: 'text',
      activeOutputStyle: setter.activeCliOutputStyle,
    });

    // Before any /output-style command — activeOutputStyle is undefined.
    expect(buildQueryOptions().activeOutputStyle).toBeUndefined();

    // After the callback fires (as wired in index.ts setOutputStyleName).
    setter.setOutputStyleName('verbose');

    const opts = buildQueryOptions();
    expect(opts.activeOutputStyle).not.toBeUndefined();
    expect(opts.activeOutputStyle?.name).toBe('verbose');
    expect(opts.activeOutputStyle?.instructions).toContain('step-by-step');
  });

  it('switching styles updates the stored value to the new style', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    await handleSlashCommand('/output-style verbose', ctx as any);
    expect(setter.activeCliOutputStyle?.name).toBe('verbose');

    await handleSlashCommand('/output-style terse', ctx as any);
    expect(setter.activeCliOutputStyle?.name).toBe('terse');
  });

  it('unknown style name falls back to "default" without throwing', async () => {
    const setter = makeStyleSetter();
    const ctx = makeReplContext(setter.setOutputStyleName);

    // handleSlashCommand itself falls back — callback receives canonical name.
    const result = await handleSlashCommand('/output-style unknown-xyz-42', ctx as any);

    expect(result?.handled).toBe(true);
    // The slash handler resolves to 'default' when name is not found.
    expect(setter.activeCliOutputStyle?.name).toBe('default');
  });
});
