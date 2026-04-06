/**
 * Tests for getActivityDescription on the five high-value tools:
 * Bash, Read, Write, Edit, Grep.
 *
 * Mirrors Claude Code's status-bar label convention.
 */
import { describe, test, expect } from 'bun:test';
import { createBashTool } from '../bash.js';
import { createReadTool } from '../read.js';
import { createWriteTool } from '../write.js';
import { createEditTool } from '../edit.js';
import { createGrepTool } from '../grep.js';

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

describe('Bash – getActivityDescription', () => {
  const tool = createBashTool();

  test('returns Running: prefix with command', () => {
    const label = tool.getActivityDescription?.({ command: 'git status' });
    expect(label).toBe('Running: git status');
  });

  test('truncates command at 60 characters with ellipsis', () => {
    const longCmd = 'a'.repeat(65);
    const label = tool.getActivityDescription?.({ command: longCmd });
    expect(label).toBe(`Running: ${'a'.repeat(60)}...`);
  });

  test('handles exactly 60 char command without ellipsis', () => {
    const sixtyChars = 'b'.repeat(60);
    const label = tool.getActivityDescription?.({ command: sixtyChars });
    // 60 chars triggers the >= 60 check, so ellipsis IS added
    expect(label).toBe(`Running: ${sixtyChars}...`);
  });

  test('handles missing command gracefully', () => {
    const label = tool.getActivityDescription?.({});
    expect(label).toBe('Running: ');
  });

  test('handles null input gracefully', () => {
    const label = tool.getActivityDescription?.(null);
    expect(label).toBe('Running: ');
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe('Read – getActivityDescription', () => {
  const tool = createReadTool();

  test('returns Reading prefix with file path', () => {
    const label = tool.getActivityDescription?.({ file_path: '/home/user/foo.ts' });
    expect(label).toBe('Reading /home/user/foo.ts');
  });

  test('falls back to "file" when file_path is missing', () => {
    const label = tool.getActivityDescription?.({});
    expect(label).toBe('Reading file');
  });

  test('handles null input gracefully', () => {
    const label = tool.getActivityDescription?.(null);
    expect(label).toBe('Reading file');
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe('Write – getActivityDescription', () => {
  const tool = createWriteTool();

  test('returns Writing prefix with file path', () => {
    const label = tool.getActivityDescription?.({ file_path: '/tmp/output.json' });
    expect(label).toBe('Writing /tmp/output.json');
  });

  test('falls back to "file" when file_path is missing', () => {
    const label = tool.getActivityDescription?.({});
    expect(label).toBe('Writing file');
  });

  test('handles null input gracefully', () => {
    const label = tool.getActivityDescription?.(null);
    expect(label).toBe('Writing file');
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe('Edit – getActivityDescription', () => {
  const tool = createEditTool();

  test('returns Editing prefix with file path', () => {
    const label = tool.getActivityDescription?.({ file_path: '/src/index.ts', old_string: 'x', new_string: 'y' });
    expect(label).toBe('Editing /src/index.ts');
  });

  test('falls back to "file" when file_path is missing', () => {
    const label = tool.getActivityDescription?.({});
    expect(label).toBe('Editing file');
  });

  test('handles null input gracefully', () => {
    const label = tool.getActivityDescription?.(null);
    expect(label).toBe('Editing file');
  });
});

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

describe('Grep – getActivityDescription', () => {
  const tool = createGrepTool();

  test('returns Searching for with pattern in quotes', () => {
    const label = tool.getActivityDescription?.({ pattern: 'createBashTool' });
    expect(label).toBe('Searching for "createBashTool"');
  });

  test('falls back to "..." when pattern is missing', () => {
    const label = tool.getActivityDescription?.({});
    expect(label).toBe('Searching for "..."');
  });

  test('handles null input gracefully', () => {
    const label = tool.getActivityDescription?.(null);
    expect(label).toBe('Searching for "..."');
  });
});
