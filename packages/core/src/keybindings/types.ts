/** Named contexts for keybinding dispatch. */
export type KeybindingContext = 'Global' | 'Chat' | 'Autocomplete' | 'Settings' | 'Help' | 'HistorySearch';

/** A single keystroke. `key` is a logical key name (e.g. 'c', 'Enter', 'ArrowUp', 'Tab', 'Escape'). */
export interface Keystroke {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** A chord is one or more keystrokes (sequential). Single-key bindings have length 1. */
export type Chord = Keystroke[];

export interface KeybindingDefinition {
  context: KeybindingContext;
  chord: Chord;
  action: string;
  description?: string;
}

export interface ParsedKeybindingsFile {
  bindings: KeybindingDefinition[];
}
