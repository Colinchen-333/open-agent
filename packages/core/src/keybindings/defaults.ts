import type { KeybindingDefinition } from './types';

/** Default keybindings matching Claude Code's common actions. */
export const DEFAULT_KEYBINDINGS: KeybindingDefinition[] = [
  { context: 'Global', chord: [{ key: 'c', ctrl: true }], action: 'interrupt', description: 'Interrupt current operation' },
  { context: 'Global', chord: [{ key: 'd', ctrl: true }], action: 'exit', description: 'Exit the REPL' },
  { context: 'Global', chord: [{ key: 'l', ctrl: true }], action: 'clear', description: 'Clear screen' },
  { context: 'Chat', chord: [{ key: 'Enter' }], action: 'submit', description: 'Submit message' },
  { context: 'Chat', chord: [{ key: 'Enter', shift: true }], action: 'newline', description: 'Insert newline' },
  { context: 'Chat', chord: [{ key: 'ArrowUp' }], action: 'history_previous', description: 'Previous history entry' },
  { context: 'Chat', chord: [{ key: 'ArrowDown' }], action: 'history_next', description: 'Next history entry' },
  { context: 'Chat', chord: [{ key: 'r', ctrl: true }], action: 'search_history', description: 'Reverse history search' },
  { context: 'Chat', chord: [{ key: 'Tab' }], action: 'autocomplete', description: 'Trigger autocomplete' },
  { context: 'Chat', chord: [{ key: 'Escape' }], action: 'cancel', description: 'Cancel current input' },
  { context: 'Chat', chord: [{ key: 'k', ctrl: true }, { key: 'c', ctrl: true }], action: 'copy_session', description: 'Copy session transcript (chord)' },
  { context: 'Autocomplete', chord: [{ key: 'Tab' }], action: 'accept', description: 'Accept suggestion' },
  { context: 'Autocomplete', chord: [{ key: 'Escape' }], action: 'dismiss', description: 'Dismiss autocomplete' },
  { context: 'Autocomplete', chord: [{ key: 'ArrowDown' }], action: 'next_suggestion', description: 'Next suggestion' },
  { context: 'Autocomplete', chord: [{ key: 'ArrowUp' }], action: 'previous_suggestion', description: 'Previous suggestion' },
  { context: 'Settings', chord: [{ key: 'Escape' }], action: 'close', description: 'Close settings' },
  { context: 'Settings', chord: [{ key: 's', ctrl: true }], action: 'save', description: 'Save settings' },
  { context: 'Help', chord: [{ key: 'Escape' }], action: 'close', description: 'Close help' },
  { context: 'HistorySearch', chord: [{ key: 'r', ctrl: true }], action: 'next_match', description: 'Next match' },
  { context: 'HistorySearch', chord: [{ key: 'Escape' }], action: 'cancel', description: 'Cancel search' },
];
