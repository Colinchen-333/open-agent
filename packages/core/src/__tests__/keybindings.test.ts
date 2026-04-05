import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseKeystroke, parseChord, parseKeybindingsFile } from '../keybindings/parser';
import { KeybindingResolver } from '../keybindings/resolver';
import { DEFAULT_KEYBINDINGS } from '../keybindings/defaults';
import { loadKeybindingResolver } from '../keybindings/loader';
import type { KeybindingDefinition } from '../keybindings/types';

// ---------------------------------------------------------------------------
// parseKeystroke
// ---------------------------------------------------------------------------

describe('parseKeystroke', () => {
  it('parses Ctrl+C', () => {
    const k = parseKeystroke('Ctrl+C');
    expect(k).toEqual({ key: 'c', ctrl: true });
  });

  it('parses Shift+Enter', () => {
    const k = parseKeystroke('Shift+Enter');
    expect(k).toEqual({ key: 'Enter', shift: true });
  });

  it('parses Cmd+K (meta)', () => {
    const k = parseKeystroke('Cmd+K');
    expect(k).toEqual({ key: 'k', meta: true });
  });

  it('parses plain ArrowUp', () => {
    const k = parseKeystroke('ArrowUp');
    expect(k).toEqual({ key: 'ArrowUp' });
  });

  it('parses plain lowercase letter', () => {
    const k = parseKeystroke('a');
    expect(k).toEqual({ key: 'a' });
  });

  it('parses Alt+Tab', () => {
    const k = parseKeystroke('Alt+Tab');
    expect(k).toEqual({ key: 'Tab', alt: true });
  });

  it('parses Option+F (alias for Alt)', () => {
    const k = parseKeystroke('Option+F');
    expect(k).toEqual({ key: 'f', alt: true });
  });

  it('parses Control (alias for Ctrl)', () => {
    const k = parseKeystroke('Control+C');
    expect(k).toEqual({ key: 'c', ctrl: true });
  });

  it('parses Win+Enter (meta)', () => {
    const k = parseKeystroke('Win+Enter');
    expect(k).toEqual({ key: 'Enter', meta: true });
  });

  it('throws on empty string', () => {
    expect(() => parseKeystroke('')).toThrow('Invalid keystroke');
  });

  it('throws on modifier-only string', () => {
    expect(() => parseKeystroke('Ctrl+Shift')).toThrow('Invalid keystroke');
  });
});

// ---------------------------------------------------------------------------
// parseChord
// ---------------------------------------------------------------------------

describe('parseChord', () => {
  it('parses a single keystroke chord', () => {
    const chord = parseChord('Enter');
    expect(chord).toHaveLength(1);
    expect(chord[0]).toEqual({ key: 'Enter' });
  });

  it('parses a two-keystroke chord', () => {
    const chord = parseChord('Ctrl+K Ctrl+C');
    expect(chord).toHaveLength(2);
    expect(chord[0]).toEqual({ key: 'k', ctrl: true });
    expect(chord[1]).toEqual({ key: 'c', ctrl: true });
  });

  it('handles extra whitespace', () => {
    const chord = parseChord('  Ctrl+K   Ctrl+C  ');
    expect(chord).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseKeybindingsFile
// ---------------------------------------------------------------------------

describe('parseKeybindingsFile', () => {
  it('parses a valid JSON array', () => {
    const raw = JSON.stringify([
      { context: 'Chat', chord: 'Ctrl+S', action: 'submit', description: 'Submit' },
      { context: 'Global', chord: 'Escape', action: 'cancel' },
    ]);
    const defs = parseKeybindingsFile(raw);
    expect(defs).toHaveLength(2);
    expect(defs[0]!.action).toBe('submit');
    expect(defs[0]!.chord).toEqual([{ key: 's', ctrl: true }]);
    expect(defs[1]!.description).toBeUndefined();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseKeybindingsFile('{invalid')).toThrow('Invalid JSON');
  });

  it('throws when root is not an array', () => {
    expect(() => parseKeybindingsFile('{"bindings":[]}')).toThrow('root must be an array');
  });

  it('skips malformed entries (missing action)', () => {
    const raw = JSON.stringify([
      { context: 'Chat', chord: 'Ctrl+S' }, // missing action
      { context: 'Chat', chord: 'Ctrl+D', action: 'delete' },
    ]);
    const defs = parseKeybindingsFile(raw);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.action).toBe('delete');
  });

  it('skips entries with bad chord (throws internally)', () => {
    const raw = JSON.stringify([
      { context: 'Chat', chord: 'Ctrl+Shift', action: 'bad' }, // Ctrl+Shift has no key
      { context: 'Chat', chord: 'Escape', action: 'good' },
    ]);
    const defs = parseKeybindingsFile(raw);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.action).toBe('good');
  });

  it('includes description when provided', () => {
    const raw = JSON.stringify([
      { context: 'Help', chord: 'Escape', action: 'close', description: 'Close help panel' },
    ]);
    const defs = parseKeybindingsFile(raw);
    expect(defs[0]!.description).toBe('Close help panel');
  });
});

// ---------------------------------------------------------------------------
// KeybindingResolver
// ---------------------------------------------------------------------------

describe('KeybindingResolver', () => {
  let resolver: KeybindingResolver;

  beforeEach(() => {
    resolver = new KeybindingResolver(DEFAULT_KEYBINDINGS);
  });

  it('resolves a default Chat binding', () => {
    const action = resolver.resolve([{ key: 'Enter' }], 'Chat');
    expect(action).toBe('submit');
  });

  it('resolves a default Global binding from Chat context (fallback)', () => {
    // Ctrl+C is Global → should resolve from Chat context via fallback
    const action = resolver.resolve([{ key: 'c', ctrl: true }], 'Chat');
    expect(action).toBe('interrupt');
  });

  it('does not fall back when context is Global', () => {
    // Enter is a Chat-only binding, should not resolve from Global
    const action = resolver.resolve([{ key: 'Enter' }], 'Global');
    expect(action).toBeNull();
  });

  it('returns null for unknown binding', () => {
    const action = resolver.resolve([{ key: 'z', ctrl: true }], 'Chat');
    expect(action).toBeNull();
  });

  it('user override wins over default', () => {
    const overrides: KeybindingDefinition[] = [
      { context: 'Chat', chord: [{ key: 'Enter' }], action: 'my_submit' },
    ];
    const r = new KeybindingResolver(DEFAULT_KEYBINDINGS, overrides);
    expect(r.resolve([{ key: 'Enter' }], 'Chat')).toBe('my_submit');
  });

  it('user override with empty action deletes default', () => {
    const overrides: KeybindingDefinition[] = [
      { context: 'Global', chord: [{ key: 'c', ctrl: true }], action: '' },
    ];
    const r = new KeybindingResolver(DEFAULT_KEYBINDINGS, overrides);
    expect(r.resolve([{ key: 'c', ctrl: true }], 'Global')).toBeNull();
    // Should also not fall back to deleted Global binding
    expect(r.resolve([{ key: 'c', ctrl: true }], 'Chat')).toBeNull();
  });

  it('user can add new bindings not in defaults', () => {
    const overrides: KeybindingDefinition[] = [
      { context: 'Chat', chord: [{ key: 'p', ctrl: true }], action: 'paste_from_clipboard' },
    ];
    const r = new KeybindingResolver(DEFAULT_KEYBINDINGS, overrides);
    expect(r.resolve([{ key: 'p', ctrl: true }], 'Chat')).toBe('paste_from_clipboard');
  });

  it('user entry with empty action for non-existent binding is ignored', () => {
    const overrides: KeybindingDefinition[] = [
      { context: 'Chat', chord: [{ key: 'z', ctrl: true }], action: '' },
    ];
    const r = new KeybindingResolver(DEFAULT_KEYBINDINGS, overrides);
    // Empty action + no default match → not added to list
    const chatBindings = r.list('Chat');
    const found = chatBindings.find(
      (b) => b.chord[0]?.key === 'z' && b.chord[0]?.ctrl,
    );
    expect(found).toBeUndefined();
  });

  it('list() returns all bindings when no context filter', () => {
    const all = resolver.list();
    expect(all.length).toBe(DEFAULT_KEYBINDINGS.length);
  });

  it('list(context) filters by context', () => {
    const chatBindings = resolver.list('Chat');
    const allChat = DEFAULT_KEYBINDINGS.filter((b) => b.context === 'Chat');
    expect(chatBindings.length).toBe(allChat.length);
  });
});

// ---------------------------------------------------------------------------
// Chord buffering / isPrefixOfChord
// ---------------------------------------------------------------------------

describe('isPrefixOfChord', () => {
  let resolver: KeybindingResolver;

  beforeEach(() => {
    resolver = new KeybindingResolver(DEFAULT_KEYBINDINGS);
  });

  it('Ctrl+K is a prefix of the Ctrl+K Ctrl+C copy_session chord', () => {
    const prefix = [{ key: 'k', ctrl: true }];
    expect(resolver.isPrefixOfChord(prefix, 'Chat')).toBe(true);
  });

  it('Ctrl+K Ctrl+C is the full chord, not a prefix of itself', () => {
    const fullChord = [{ key: 'k', ctrl: true }, { key: 'c', ctrl: true }];
    expect(resolver.isPrefixOfChord(fullChord, 'Chat')).toBe(false);
  });

  it('returns false for non-prefix', () => {
    const notPrefix = [{ key: 'x', ctrl: true }];
    expect(resolver.isPrefixOfChord(notPrefix, 'Chat')).toBe(false);
  });

  it('Ctrl+K is not a prefix in Global context (the chord belongs to Chat)', () => {
    // The copy_session chord is in Chat context, so Global alone won't see it
    // (isPrefixOfChord checks b.context === context || b.context === 'Global')
    const prefix = [{ key: 'k', ctrl: true }];
    expect(resolver.isPrefixOfChord(prefix, 'Global')).toBe(false);
  });

  it('copy_session chord itself resolves to correct action', () => {
    const chord = [{ key: 'k', ctrl: true }, { key: 'c', ctrl: true }];
    expect(resolver.resolve(chord, 'Chat')).toBe('copy_session');
  });
});

// ---------------------------------------------------------------------------
// loadKeybindingResolver
// ---------------------------------------------------------------------------

describe('loadKeybindingResolver', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'kb-test-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('returns defaults-only resolver when no keybindings.json exists', async () => {
    const resolver = await loadKeybindingResolver(tmpHome);
    // Should have all defaults
    const all = resolver.list();
    expect(all.length).toBe(DEFAULT_KEYBINDINGS.length);
  });

  it('merges user keybindings from file', async () => {
    const claudeDir = join(tmpHome, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'keybindings.json'),
      JSON.stringify([
        { context: 'Chat', chord: 'Ctrl+S', action: 'my_save' },
      ]),
      'utf8',
    );
    const resolver = await loadKeybindingResolver(tmpHome);
    expect(resolver.resolve([{ key: 's', ctrl: true }], 'Chat')).toBe('my_save');
    // Defaults are still present
    expect(resolver.resolve([{ key: 'Enter' }], 'Chat')).toBe('submit');
  });

  it('falls back to defaults when keybindings.json is invalid JSON', async () => {
    const claudeDir = join(tmpHome, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'keybindings.json'), '{broken json}', 'utf8');
    // Should not throw — loader swallows parse errors
    const resolver = await loadKeybindingResolver(tmpHome);
    const all = resolver.list();
    expect(all.length).toBe(DEFAULT_KEYBINDINGS.length);
  });

  it('user override with empty action removes a default via file', async () => {
    const claudeDir = join(tmpHome, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'keybindings.json'),
      JSON.stringify([
        { context: 'Global', chord: 'Ctrl+C', action: '' },
      ]),
      'utf8',
    );
    const resolver = await loadKeybindingResolver(tmpHome);
    expect(resolver.resolve([{ key: 'c', ctrl: true }], 'Global')).toBeNull();
  });
});
