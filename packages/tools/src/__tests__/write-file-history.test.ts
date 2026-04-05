import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setFeatureDefault, clearFeatureOverrides, fileHistory } from '@open-agent/core';
import { createWriteTool } from '../write.js';

describe('Write tool — FILE_HISTORY integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-write-history-'));
    setFeatureDefault('FILE_HISTORY', true);
    fileHistory.clear('hist-session');
  });

  afterEach(() => {
    clearFeatureOverrides();
    fileHistory.clear('hist-session');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a snapshot in fileHistory when FILE_HISTORY is enabled and ctx has sessionId+toolUseId', async () => {
    const tool = createWriteTool();
    const filePath = join(tmpDir, 'tracked.txt');

    const ctx = {
      cwd: tmpDir,
      sessionId: 'hist-session',
      toolUseId: 'tool-use-abc',
    };

    await tool.execute({ file_path: filePath, content: 'hello' }, ctx);

    const snapshots = fileHistory.list('hist-session');
    expect(snapshots.length).toBeGreaterThan(0);
    const snap = snapshots.find((s) => s.filePath === filePath);
    expect(snap).toBeDefined();
    expect(snap!.messageUuid).toBe('tool-use-abc');
    // File didn't exist before — prevContent should be null
    expect(snap!.prevContent).toBeNull();
  });

  it('captures the previous content when overwriting an existing file', async () => {
    const tool = createWriteTool();
    const filePath = join(tmpDir, 'existing-tracked.txt');

    // Pre-create the file
    writeFileSync(filePath, 'original content', 'utf-8');

    const ctx = {
      cwd: tmpDir,
      sessionId: 'hist-session',
      toolUseId: 'tool-use-xyz',
      // fileReadTracker is omitted — write.ts only requires it for existing-file overwrite,
      // but the test calls execute() which will throw if exists && not-read.
      // Provide a passthrough tracker to bypass the safety check.
      fileReadTracker: {
        hasBeenRead: () => true,
        markRead: () => {},
      },
    };

    await tool.execute({ file_path: filePath, content: 'new content' }, ctx);

    const snapshots = fileHistory.list('hist-session');
    const snap = snapshots.find((s) => s.filePath === filePath);
    expect(snap).toBeDefined();
    expect(snap!.prevContent).toBe('original content');
  });

  it('does NOT record a snapshot when FILE_HISTORY is disabled', async () => {
    clearFeatureOverrides();
    setFeatureDefault('FILE_HISTORY', false);

    const tool = createWriteTool();
    const filePath = join(tmpDir, 'untracked.txt');

    const ctx = {
      cwd: tmpDir,
      sessionId: 'hist-session',
      toolUseId: 'tool-use-disabled',
    };

    await tool.execute({ file_path: filePath, content: 'no history' }, ctx);

    expect(fileHistory.list('hist-session').length).toBe(0);
  });

  it('does NOT record a snapshot when ctx lacks toolUseId', async () => {
    const tool = createWriteTool();
    const filePath = join(tmpDir, 'no-tooluse-id.txt');

    const ctx = {
      cwd: tmpDir,
      sessionId: 'hist-session',
      // toolUseId intentionally omitted
    };

    await tool.execute({ file_path: filePath, content: 'no tool use id' }, ctx);

    expect(fileHistory.list('hist-session').length).toBe(0);
  });
});
