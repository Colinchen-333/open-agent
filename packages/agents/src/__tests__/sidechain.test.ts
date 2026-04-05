import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SidechainWriter, sidechainPath } from '../sidechain';

describe('sidechain', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(`${tmpdir()}/oa-sidechain-`); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('sidechainPath returns sidechain/<agentId>/messages.jsonl', () => {
    expect(sidechainPath(root, 'agent-abc')).toBe(
      `${root}/sidechain/agent-abc/messages.jsonl`,
    );
  });

  test('SidechainWriter appends JSONL records', async () => {
    const w = new SidechainWriter(sidechainPath(root, 'a'));
    await w.append({ type: 'user', text: 'm1' });
    await w.append({ type: 'assistant', text: 'r1' });
    const path = sidechainPath(root, 'a');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
  });

  test('SidechainWriter creates parent directories on first append', async () => {
    const deepRoot = `${root}/deep/nested`;
    const w = new SidechainWriter(sidechainPath(deepRoot, 'b'));
    await w.append({ type: 'user', text: 'hello' });
    expect(existsSync(sidechainPath(deepRoot, 'b'))).toBe(true);
  });

  test('SidechainWriter serialises records as valid JSON lines', async () => {
    const w = new SidechainWriter(sidechainPath(root, 'c'));
    const record = { role: 'assistant', content: 'ok', tokens: 42 };
    await w.append(record);
    const raw = readFileSync(sidechainPath(root, 'c'), 'utf8').trim();
    expect(JSON.parse(raw)).toEqual(record);
  });
});
