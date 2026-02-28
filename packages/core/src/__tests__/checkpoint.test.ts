import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileCheckpoint } from '../checkpoint.js';

describe('FileCheckpoint', () => {
  let baseDir: string;
  let filePath: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'open-agent-checkpoint-'));
    filePath = join(baseDir, 'demo.txt');
    writeFileSync(filePath, 'v1', 'utf-8');
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('reloads checkpoints from disk after process restart', () => {
    const first = new FileCheckpoint(baseDir);
    first.save('tool-1', filePath);
    writeFileSync(filePath, 'v2', 'utf-8');
    first.save('tool-2', filePath);
    writeFileSync(filePath, 'v3', 'utf-8');

    const second = new FileCheckpoint(baseDir);
    const list = second.list();
    expect(list.length).toBeGreaterThanOrEqual(2);

    const rewound = second.rewindTo('tool-1');
    expect(rewound.errors).toHaveLength(0);
    expect(rewound.restored).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('v1');
  });
});
