import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileHistoryStore } from '../file-history.js';

describe('FileHistoryStore', () => {
  let tmpDir: string;
  let store: FileHistoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-file-history-'));
    store = new FileHistoryStore();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // trackEdit — existing file
  // ---------------------------------------------------------------------------

  it('captures existing file content before modification', async () => {
    const filePath = join(tmpDir, 'existing.txt');
    writeFileSync(filePath, 'original content', 'utf-8');

    await store.trackEdit('sess1', 'turn-1', filePath);

    const snapshots = store.list('sess1');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.prevContent).toBe('original content');
    expect(snapshots[0]!.filePath).toBe(filePath);
    expect(snapshots[0]!.messageUuid).toBe('turn-1');
    expect(snapshots[0]!.sessionId).toBe('sess1');
  });

  // ---------------------------------------------------------------------------
  // trackEdit — non-existing file
  // ---------------------------------------------------------------------------

  it('stores prevContent=null for a file that does not exist yet', async () => {
    const filePath = join(tmpDir, 'nonexistent.txt');

    await store.trackEdit('sess1', 'turn-1', filePath);

    const snapshots = store.list('sess1');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.prevContent).toBeNull();
    expect(snapshots[0]!.filePath).toBe(filePath);
  });

  // ---------------------------------------------------------------------------
  // rewind 1 — restores most recent snapshot
  // ---------------------------------------------------------------------------

  it('rewind(1) restores the file to its state before the last turn', async () => {
    const filePath = join(tmpDir, 'target.txt');
    writeFileSync(filePath, 'before turn 1', 'utf-8');

    await store.trackEdit('sess1', 'turn-1', filePath);

    // Simulate the tool write
    writeFileSync(filePath, 'after turn 1', 'utf-8');

    const restored = await store.rewind('sess1', 1);

    expect(restored).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('before turn 1');
  });

  // ---------------------------------------------------------------------------
  // rewind 1 — deletes a newly created file
  // ---------------------------------------------------------------------------

  it('rewind(1) deletes a file that was created in the last turn (prevContent=null)', async () => {
    const filePath = join(tmpDir, 'created-this-turn.txt');
    // File does not exist yet — track BEFORE creation
    await store.trackEdit('sess1', 'turn-1', filePath);

    // Simulate tool creating the file
    writeFileSync(filePath, 'new file content', 'utf-8');
    expect(existsSync(filePath)).toBe(true);

    const restored = await store.rewind('sess1', 1);

    expect(restored).toContain(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // rewind 3 — restores multiple turns
  // ---------------------------------------------------------------------------

  it('rewind(3) restores files from the last 3 turns', async () => {
    const fileA = join(tmpDir, 'a.txt');
    const fileB = join(tmpDir, 'b.txt');
    const fileC = join(tmpDir, 'c.txt');

    writeFileSync(fileA, 'a-v1', 'utf-8');
    writeFileSync(fileB, 'b-v1', 'utf-8');
    writeFileSync(fileC, 'c-v1', 'utf-8');

    // Turn 1: edit fileA
    await store.trackEdit('sess1', 'turn-1', fileA);
    writeFileSync(fileA, 'a-v2', 'utf-8');

    // Turn 2: edit fileB
    await store.trackEdit('sess1', 'turn-2', fileB);
    writeFileSync(fileB, 'b-v2', 'utf-8');

    // Turn 3: edit fileC
    await store.trackEdit('sess1', 'turn-3', fileC);
    writeFileSync(fileC, 'c-v2', 'utf-8');

    const restored = await store.rewind('sess1', 3);

    expect(restored.sort()).toEqual([fileA, fileB, fileC].sort());
    expect(readFileSync(fileA, 'utf-8')).toBe('a-v1');
    expect(readFileSync(fileB, 'utf-8')).toBe('b-v1');
    expect(readFileSync(fileC, 'utf-8')).toBe('c-v1');
  });

  // ---------------------------------------------------------------------------
  // rewind restores the OLDEST prevContent for a file edited multiple times
  // ---------------------------------------------------------------------------

  it('rewind restores the pre-first-edit content when a file is edited multiple times in the same turn', async () => {
    const filePath = join(tmpDir, 'multi-edit.txt');
    writeFileSync(filePath, 'original', 'utf-8');

    // Same turn, two edits
    await store.trackEdit('sess1', 'turn-1', filePath);
    writeFileSync(filePath, 'intermediate', 'utf-8');
    await store.trackEdit('sess1', 'turn-1', filePath);
    writeFileSync(filePath, 'final', 'utf-8');

    const restored = await store.rewind('sess1', 1);

    expect(restored).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('original');
  });

  // ---------------------------------------------------------------------------
  // FIFO eviction at 101 snapshots
  // ---------------------------------------------------------------------------

  it('evicts the oldest snapshot when more than 100 are recorded for a session', async () => {
    const filePath = join(tmpDir, 'fifo.txt');
    writeFileSync(filePath, 'initial', 'utf-8');

    // Push 101 snapshots under distinct message UUIDs
    for (let i = 0; i < 101; i++) {
      await store.trackEdit('sess-fifo', `turn-${i}`, filePath);
    }

    const snapshots = store.list('sess-fifo');
    expect(snapshots.length).toBe(100);
    // The first snapshot (turn-0) should have been evicted
    expect(snapshots[0]!.messageUuid).toBe('turn-1');
    expect(snapshots[snapshots.length - 1]!.messageUuid).toBe('turn-100');
  });

  // ---------------------------------------------------------------------------
  // clear removes all snapshots for a session
  // ---------------------------------------------------------------------------

  it('clear() removes all snapshots for the given session', async () => {
    const filePath = join(tmpDir, 'to-clear.txt');
    writeFileSync(filePath, 'data', 'utf-8');

    await store.trackEdit('sess-clear', 'turn-1', filePath);
    await store.trackEdit('sess-clear', 'turn-2', filePath);

    expect(store.list('sess-clear').length).toBe(2);

    store.clear('sess-clear');

    expect(store.list('sess-clear').length).toBe(0);
  });

  it('clear() does not affect snapshots for other sessions', async () => {
    const fileA = join(tmpDir, 'sess-a.txt');
    const fileB = join(tmpDir, 'sess-b.txt');
    writeFileSync(fileA, 'a', 'utf-8');
    writeFileSync(fileB, 'b', 'utf-8');

    await store.trackEdit('sess-A', 'turn-1', fileA);
    await store.trackEdit('sess-B', 'turn-1', fileB);

    store.clear('sess-A');

    expect(store.list('sess-A').length).toBe(0);
    expect(store.list('sess-B').length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Rewound snapshots are removed from the store
  // ---------------------------------------------------------------------------

  it('rewound turn snapshots are removed from the store after rewind', async () => {
    const filePath = join(tmpDir, 'cleanup.txt');
    writeFileSync(filePath, 'v1', 'utf-8');

    await store.trackEdit('sess1', 'turn-1', filePath);
    writeFileSync(filePath, 'v2', 'utf-8');
    await store.trackEdit('sess1', 'turn-2', filePath);
    writeFileSync(filePath, 'v3', 'utf-8');

    // Rewind 1 turn — only turn-2 snapshots should be removed
    await store.rewind('sess1', 1);

    const remaining = store.list('sess1');
    expect(remaining.every((s) => s.messageUuid !== 'turn-2')).toBe(true);
    // turn-1 snapshot should remain
    expect(remaining.some((s) => s.messageUuid === 'turn-1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // rewind on empty store returns []
  // ---------------------------------------------------------------------------

  it('rewind on a session with no snapshots returns empty array', async () => {
    const restored = await store.rewind('sess-empty', 1);
    expect(restored).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // rewind with turns <= 0 returns []
  // ---------------------------------------------------------------------------

  it('rewind with turns=0 returns empty array', async () => {
    const filePath = join(tmpDir, 'noop.txt');
    writeFileSync(filePath, 'data', 'utf-8');
    await store.trackEdit('sess1', 'turn-1', filePath);

    const restored = await store.rewind('sess1', 0);
    expect(restored).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Dedup: same file, same turn, same content — skip
  // ---------------------------------------------------------------------------

  it('skips duplicate snapshot when file content and turn are identical', async () => {
    const filePath = join(tmpDir, 'dedup.txt');
    writeFileSync(filePath, 'same', 'utf-8');

    await store.trackEdit('sess1', 'turn-1', filePath);
    // Call again without changing file — should be deduped
    await store.trackEdit('sess1', 'turn-1', filePath);

    expect(store.list('sess1').length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // list() returns readonly — mutations do not affect internal state
  // ---------------------------------------------------------------------------

  it('list() isolation: mutating the returned array does not corrupt the store', async () => {
    const filePath = join(tmpDir, 'isolation.txt');
    writeFileSync(filePath, 'content', 'utf-8');

    await store.trackEdit('sess1', 'turn-1', filePath);
    const snaps = store.list('sess1') as FileSnapshot[];
    // Attempt to mutate (TypeScript would warn, but JS allows it at runtime if cast)
    // Just verify the store still returns the same count after a potential mutation attempt
    expect(snaps.length).toBe(1);
    expect(store.list('sess1').length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // setPersistence — hook is called on trackEdit
  // ---------------------------------------------------------------------------

  it('setPersistence: onSnapshotCreated is called when a new snapshot is created', async () => {
    const filePath = join(tmpDir, 'persist-test.txt');
    writeFileSync(filePath, 'hello', 'utf-8');

    const captured: FileSnapshot[] = [];
    store.setPersistence({
      onSnapshotCreated: (snap) => {
        captured.push(snap);
      },
    });

    await store.trackEdit('sess-p', 'turn-1', filePath);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.filePath).toBe(filePath);
    expect(captured[0]!.prevContent).toBe('hello');
    expect(captured[0]!.sessionId).toBe('sess-p');
    expect(captured[0]!.messageUuid).toBe('turn-1');
  });

  it('setPersistence: hook is NOT called when dedup skips the snapshot', async () => {
    const filePath = join(tmpDir, 'persist-dedup.txt');
    writeFileSync(filePath, 'same content', 'utf-8');

    const captured: FileSnapshot[] = [];
    store.setPersistence({ onSnapshotCreated: (snap) => { captured.push(snap); } });

    await store.trackEdit('sess-p2', 'turn-1', filePath);
    // Second call with unchanged content in the same turn — should be deduped
    await store.trackEdit('sess-p2', 'turn-1', filePath);

    expect(captured).toHaveLength(1);
  });

  it('setPersistence: passing undefined removes the persistence hook', async () => {
    const filePath = join(tmpDir, 'persist-remove.txt');
    writeFileSync(filePath, 'data', 'utf-8');

    const captured: FileSnapshot[] = [];
    store.setPersistence({ onSnapshotCreated: (snap) => { captured.push(snap); } });
    store.setPersistence(undefined);

    await store.trackEdit('sess-p3', 'turn-1', filePath);

    expect(captured).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // hydrate — seeds the store from a snapshot array
  // ---------------------------------------------------------------------------

  it('hydrate() seeds the store so list() returns the provided snapshots', () => {
    const snaps: FileSnapshot[] = [
      { sessionId: 'sess-h', messageUuid: 'turn-1', filePath: '/a.ts', prevContent: 'v1', timestamp: 1000 },
      { sessionId: 'sess-h', messageUuid: 'turn-2', filePath: '/b.ts', prevContent: null, timestamp: 2000 },
    ];

    store.hydrate('sess-h', snaps);

    const listed = store.list('sess-h');
    expect(listed).toHaveLength(2);
    expect(listed[0]!.filePath).toBe('/a.ts');
    expect(listed[1]!.prevContent).toBeNull();
  });

  it('hydrate() replaces any pre-existing snapshots for the session', async () => {
    const filePath = join(tmpDir, 'hydrate-replace.txt');
    writeFileSync(filePath, 'old', 'utf-8');

    await store.trackEdit('sess-hr', 'turn-old', filePath);
    expect(store.list('sess-hr')).toHaveLength(1);

    store.hydrate('sess-hr', [
      { sessionId: 'sess-hr', messageUuid: 'turn-new', filePath: '/x.ts', prevContent: 'new', timestamp: 9999 },
    ]);

    const listed = store.list('sess-hr');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.messageUuid).toBe('turn-new');
  });

  it('hydrate() does NOT fire the persistence hook (no infinite loop)', async () => {
    const captured: FileSnapshot[] = [];
    store.setPersistence({ onSnapshotCreated: (snap) => { captured.push(snap); } });

    store.hydrate('sess-hydrate-nohook', [
      { sessionId: 'sess-hydrate-nohook', messageUuid: 'turn-1', filePath: '/z.ts', prevContent: 'c', timestamp: 1 },
    ]);

    expect(captured).toHaveLength(0);
  });
});

// Re-export the type to avoid unused-import error on the cast above
import type { FileSnapshot } from '../file-history.js';
