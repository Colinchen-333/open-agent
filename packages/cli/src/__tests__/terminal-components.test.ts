import { describe, expect, test } from 'bun:test';
import {
  renderText,
  renderBox,
  renderTable,
  renderProgressBar,
  stripAnsi,
  TerminalSpinner,
} from '../terminal-components';

// ---------------------------------------------------------------------------
// stripAnsi (helper)
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  test('returns plain text unchanged', () => {
    expect(stripAnsi('hello')).toBe('hello');
  });

  test('strips ANSI color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  test('strips nested codes', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mbold red\x1b[0m\x1b[0m')).toBe('bold red');
  });
});

// ---------------------------------------------------------------------------
// renderText
// ---------------------------------------------------------------------------

describe('renderText', () => {
  test('returns plain text with no options', () => {
    expect(renderText('hello')).toBe('hello');
  });

  test('returns plain text with undefined options', () => {
    expect(renderText('hello', undefined)).toBe('hello');
  });

  test('applies bold', () => {
    const result = renderText('bold', { bold: true });
    expect(result).toContain('bold');
    expect(result).not.toBe('bold'); // has ANSI codes
    expect(stripAnsi(result)).toBe('bold');
  });

  test('applies dim', () => {
    const result = renderText('dim', { dimColor: true });
    expect(result).toContain('dim');
    expect(result).not.toBe('dim');
    expect(stripAnsi(result)).toBe('dim');
  });

  test('applies italic', () => {
    const result = renderText('it', { italic: true });
    expect(stripAnsi(result)).toBe('it');
    expect(result).not.toBe('it');
  });

  test('applies underline', () => {
    const result = renderText('u', { underline: true });
    expect(stripAnsi(result)).toBe('u');
    expect(result).not.toBe('u');
  });

  test('applies strikethrough', () => {
    const result = renderText('s', { strikethrough: true });
    expect(stripAnsi(result)).toBe('s');
    expect(result).not.toBe('s');
  });

  test('applies color', () => {
    const result = renderText('red', { color: 'red' });
    expect(stripAnsi(result)).toBe('red');
    expect(result).toContain('\x1b[31m');
  });

  test('ignores unknown color gracefully', () => {
    const result = renderText('test', { color: 'nonexistent' });
    expect(stripAnsi(result)).toBe('test');
  });

  test('combines multiple styles', () => {
    const result = renderText('multi', { bold: true, color: 'cyan', italic: true });
    expect(stripAnsi(result)).toBe('multi');
    // Should contain both bold and cyan ANSI codes
    expect(result).toContain('\x1b[1m');
    expect(result).toContain('\x1b[36m');
  });
});

// ---------------------------------------------------------------------------
// renderBox
// ---------------------------------------------------------------------------

describe('renderBox', () => {
  test('renders content with no border (default)', () => {
    expect(renderBox('hello')).toBe('hello');
  });

  test('renders single border', () => {
    const result = renderBox('hi', { borderStyle: 'single' });
    expect(result).toContain('┌');
    expect(result).toContain('│');
    expect(result).toContain('└');
    expect(result).toContain('hi');
  });

  test('renders round border', () => {
    const result = renderBox('test', { borderStyle: 'round' });
    expect(result).toContain('╭');
    expect(result).toContain('╯');
  });

  test('renders double border', () => {
    const result = renderBox('db', { borderStyle: 'double' });
    expect(result).toContain('╔');
    expect(result).toContain('║');
    expect(result).toContain('╝');
  });

  test('renders bold border', () => {
    const result = renderBox('b', { borderStyle: 'bold' });
    expect(result).toContain('┏');
    expect(result).toContain('┃');
    expect(result).toContain('┛');
  });

  test('renders classic border', () => {
    const result = renderBox('c', { borderStyle: 'classic' });
    expect(result).toContain('+');
    expect(result).toContain('|');
    expect(result).toContain('-');
  });

  test('applies padding', () => {
    const result = renderBox('x', { borderStyle: 'single', padding: 1 });
    const lines = result.split('\n');
    // top border + 1 pad + content + 1 pad + bottom border = 5 lines
    expect(lines.length).toBe(5);
  });

  test('applies asymmetric padding', () => {
    const result = renderBox('x', {
      borderStyle: 'single',
      padding: { top: 2, bottom: 0, left: 3, right: 3 },
    });
    const lines = result.split('\n');
    // top border + 2 pad + content + 0 pad + bottom border = 5 lines
    expect(lines.length).toBe(5);
  });

  test('applies margin', () => {
    const result = renderBox('x', { margin: { top: 1, bottom: 1 } });
    const lines = result.split('\n');
    expect(lines[0]).toBe('');
    expect(lines[lines.length - 1]).toBe('');
  });

  test('applies left margin', () => {
    const result = renderBox('x', {
      borderStyle: 'single',
      margin: { left: 4 },
    });
    const lines = result.split('\n');
    for (const line of lines) {
      expect(line.startsWith('    ')).toBe(true);
    }
  });

  test('handles multiline content', () => {
    const result = renderBox('line1\nline2', { borderStyle: 'single' });
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    const lines = result.split('\n');
    // top border + 2 content lines + bottom border = 4
    expect(lines.length).toBe(4);
  });

  test('applies border color', () => {
    const result = renderBox('x', { borderStyle: 'single', borderColor: 'red' });
    expect(result).toContain('\x1b[31m'); // red ANSI code
  });

  test('handles explicit width', () => {
    const result = renderBox('hi', { borderStyle: 'single', width: 20 });
    const lines = result.split('\n');
    // The top border line should be exactly 20 visible chars wide
    expect(stripAnsi(lines[0]!).length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// renderTable
// ---------------------------------------------------------------------------

describe('renderTable', () => {
  test('renders headers and rows', () => {
    const result = renderTable(
      ['Name', 'Age'],
      [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
    );
    expect(result).toContain('Alice');
    expect(result).toContain('30');
    expect(result).toContain('─');
  });

  test('handles empty rows', () => {
    const result = renderTable(['A', 'B'], []);
    expect(stripAnsi(result)).toContain('A');
    expect(result).toContain('─');
    const lines = result.split('\n');
    // header + separator only
    expect(lines.length).toBe(2);
  });

  test('aligns columns correctly', () => {
    const result = renderTable(
      ['X', 'LongHeader'],
      [
        ['short', 'y'],
        ['a', 'longer value'],
      ],
    );
    const lines = result.split('\n');
    // All non-separator lines should have consistent structure
    expect(lines.length).toBe(4); // header + separator + 2 rows
  });

  test('respects custom padding', () => {
    const result = renderTable(['A', 'B'], [['1', '2']], { padding: 3 });
    // With padding 3, columns should be separated by 3 spaces
    const bodyLine = stripAnsi(result.split('\n')[2]!);
    expect(bodyLine).toContain('   '); // 3-space gap
  });
});

// ---------------------------------------------------------------------------
// renderProgressBar
// ---------------------------------------------------------------------------

describe('renderProgressBar', () => {
  test('renders 0%', () => {
    const result = renderProgressBar(0);
    expect(result).toContain('0%');
    expect(result).toContain('░');
  });

  test('renders 100%', () => {
    const result = renderProgressBar(1);
    expect(result).toContain('100%');
    expect(result).toContain('█');
  });

  test('renders 50%', () => {
    const result = renderProgressBar(0.5);
    expect(result).toContain('50%');
  });

  test('clamps values above 1', () => {
    const result = renderProgressBar(1.5);
    expect(result).toContain('100%');
  });

  test('clamps values below 0', () => {
    const result = renderProgressBar(-0.5);
    expect(result).toContain('0%');
  });

  test('respects custom width', () => {
    const result = renderProgressBar(0.5, { width: 20 });
    const plain = stripAnsi(result);
    // 20 bar chars + space + percentage
    expect(plain).toMatch(/^[█░]{20} 50%$/);
  });

  test('respects custom characters', () => {
    const result = renderProgressBar(0.5, {
      width: 10,
      complete: '#',
      incomplete: '.',
    });
    const plain = stripAnsi(result);
    expect(plain).toContain('#');
    expect(plain).toContain('.');
  });

  test('applies color', () => {
    const result = renderProgressBar(0.5, { color: 'cyan' });
    expect(result).toContain('\x1b[36m'); // cyan
  });
});

// ---------------------------------------------------------------------------
// TerminalSpinner
// ---------------------------------------------------------------------------

describe('TerminalSpinner', () => {
  test('creates with default options', () => {
    const spinner = new TerminalSpinner();
    const frame = spinner.frame();
    expect(frame.length).toBeGreaterThan(0);
  });

  test('creates with label', () => {
    const spinner = new TerminalSpinner({ label: 'Loading...' });
    expect(spinner.frame()).toContain('Loading...');
  });

  test('updates label', () => {
    const spinner = new TerminalSpinner({ label: 'old' });
    spinner.setLabel('new');
    expect(spinner.frame()).toContain('new');
    expect(spinner.frame()).not.toContain('old');
  });

  test('creates with different spinner types', () => {
    for (const type of ['dots', 'line', 'pipe', 'star', 'bounce'] as const) {
      const spinner = new TerminalSpinner({ type });
      expect(spinner.frame().length).toBeGreaterThan(0);
    }
  });

  test('applies color', () => {
    const spinner = new TerminalSpinner({ color: 'red' });
    const frame = spinner.frame();
    expect(frame).toContain('\x1b[31m'); // red
  });

  test('defaults to cyan color', () => {
    const spinner = new TerminalSpinner();
    const frame = spinner.frame();
    expect(frame).toContain('\x1b[36m'); // cyan
  });
});
