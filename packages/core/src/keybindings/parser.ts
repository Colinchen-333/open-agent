import type { Chord, Keystroke, KeybindingDefinition, KeybindingContext } from './types';

/**
 * Parse a string keystroke spec into a Keystroke object.
 * Examples:
 *   'Ctrl+C' → { key: 'c', ctrl: true }
 *   'Shift+Enter' → { key: 'Enter', shift: true }
 *   'Cmd+K' → { key: 'k', meta: true }
 *   'ArrowUp' → { key: 'ArrowUp' }
 */
export function parseKeystroke(s: string): Keystroke {
  const parts = s.split('+').map((p) => p.trim());
  const keystroke: Keystroke = { key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') keystroke.ctrl = true;
    else if (lower === 'alt' || lower === 'option' || lower === 'opt') keystroke.alt = true;
    else if (lower === 'shift') keystroke.shift = true;
    else if (lower === 'cmd' || lower === 'meta' || lower === 'super' || lower === 'win') keystroke.meta = true;
    else {
      // Normalize single-letter keys to lowercase; named keys preserved
      keystroke.key = part.length === 1 ? part.toLowerCase() : part;
    }
  }
  if (!keystroke.key) throw new Error(`Invalid keystroke: ${s}`);
  return keystroke;
}

/**
 * Parse a chord string: space-separated keystrokes.
 * "Ctrl+K Ctrl+C" → [{key: 'k', ctrl: true}, {key: 'c', ctrl: true}]
 */
export function parseChord(s: string): Chord {
  return s.split(/\s+/).filter(Boolean).map(parseKeystroke);
}

/**
 * Parse a raw JSON file content (the user's keybindings.json).
 * Expected shape:
 * [
 *   { "context": "Chat", "chord": "Ctrl+S", "action": "submit" },
 *   ...
 * ]
 */
export function parseKeybindingsFile(raw: string): KeybindingDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('keybindings.json root must be an array');
  }
  const out: KeybindingDefinition[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.context !== 'string' || typeof e.chord !== 'string' || typeof e.action !== 'string') {
      continue;
    }
    try {
      out.push({
        context: e.context as KeybindingContext,
        chord: parseChord(e.chord),
        action: e.action,
        description: typeof e.description === 'string' ? e.description : undefined,
      });
    } catch {
      // Skip malformed entries silently
    }
  }
  return out;
}
