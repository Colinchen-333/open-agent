import type { Chord, Keystroke, KeybindingContext, KeybindingDefinition } from './types';

/** Compare two Keystrokes for exact structural equality. */
function keystrokesEqual(a: Keystroke, b: Keystroke): boolean {
  return (
    a.key === b.key &&
    !!a.ctrl === !!b.ctrl &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    !!a.meta === !!b.meta
  );
}

function chordsEqual(a: Chord, b: Chord): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!keystrokesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/**
 * Keybinding resolver. Merges default bindings with user overrides and resolves
 * a chord + context to an action.
 *
 * User bindings take precedence: if the same (context, chord) exists in both,
 * the user entry wins. User entries with an empty action can DELETE a default.
 */
export class KeybindingResolver {
  private bindings: KeybindingDefinition[];

  constructor(defaults: KeybindingDefinition[], userOverrides: KeybindingDefinition[] = []) {
    // Build the merged list: start with defaults, then apply overrides
    const merged = [...defaults];
    for (const override of userOverrides) {
      const idx = merged.findIndex(
        (b) => b.context === override.context && chordsEqual(b.chord, override.chord),
      );
      if (idx !== -1) {
        if (override.action === '') {
          // Empty action → delete the default binding
          merged.splice(idx, 1);
        } else {
          merged[idx] = override;
        }
      } else if (override.action !== '') {
        merged.push(override);
      }
    }
    this.bindings = merged;
  }

  /**
   * Find the action bound to a given chord + context.
   * Falls back to the 'Global' context if no match in the specific context.
   */
  resolve(chord: Chord, context: KeybindingContext): string | null {
    // Search context-specific first
    for (const b of this.bindings) {
      if (b.context === context && chordsEqual(b.chord, chord)) return b.action;
    }
    // Fall back to Global
    if (context !== 'Global') {
      for (const b of this.bindings) {
        if (b.context === 'Global' && chordsEqual(b.chord, chord)) return b.action;
      }
    }
    return null;
  }

  /** List all bindings for a context. */
  list(context?: KeybindingContext): KeybindingDefinition[] {
    return context ? this.bindings.filter((b) => b.context === context) : [...this.bindings];
  }

  /** Check if any multi-keystroke chord starts with this prefix (for chord buffering). */
  isPrefixOfChord(prefix: Chord, context: KeybindingContext): boolean {
    for (const b of this.bindings) {
      if (b.context !== context && b.context !== 'Global') continue;
      if (b.chord.length <= prefix.length) continue;
      let matches = true;
      for (let i = 0; i < prefix.length; i++) {
        if (!keystrokesEqual(b.chord[i]!, prefix[i]!)) { matches = false; break; }
      }
      if (matches) return true;
    }
    return false;
  }
}
