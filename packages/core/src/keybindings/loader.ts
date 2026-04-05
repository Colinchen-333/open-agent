import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseKeybindingsFile } from './parser';
import { DEFAULT_KEYBINDINGS } from './defaults';
import { KeybindingResolver } from './resolver';

/**
 * Load the user's keybindings.json from ~/.claude/keybindings.json,
 * merge with defaults, and return a resolver.
 */
export async function loadKeybindingResolver(home?: string): Promise<KeybindingResolver> {
  const userHome = home ?? homedir();
  const path = join(userHome, '.claude', 'keybindings.json');
  let userBindings: ReturnType<typeof parseKeybindingsFile> = [];
  try {
    await access(path);
    const raw = await readFile(path, 'utf8');
    userBindings = parseKeybindingsFile(raw);
  } catch {
    // No user file or parse error → use defaults only
  }
  return new KeybindingResolver(DEFAULT_KEYBINDINGS, userBindings);
}
