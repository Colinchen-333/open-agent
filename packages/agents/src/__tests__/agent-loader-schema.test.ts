import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUserAgents } from '../agent-loader.js';

describe('AgentDefinition schema expansion (R5.5)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(`${tmpdir()}/oa-agent-home-`);
    cwd = mkdtempSync(`${tmpdir()}/oa-agent-cwd-`);
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeAgent(name: string, frontmatter: string, body = 'Agent body.'): void {
    writeFileSync(
      join(home, '.claude', 'agents', `${name}.md`),
      `---\n${frontmatter}\n---\n${body}`,
      'utf8',
    );
  }

  test('parses effort field', async () => {
    writeAgent('test-effort', 'name: test-effort\neffort: high');
    const agents = await loadUserAgents(cwd, home);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.effort).toBe('high');
  });

  test('ignores invalid effort values', async () => {
    writeAgent('test-bad-effort', 'name: test-bad\neffort: insane');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.effort).toBeUndefined();
  });

  test('parses permissionMode field', async () => {
    writeAgent('test-perm', 'name: test-perm\npermissionMode: plan');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.permissionMode).toBe('plan');
  });

  test('parses kebab-case permission-mode alias', async () => {
    writeAgent('test-perm-kebab', 'name: test-perm-kebab\npermission-mode: acceptEdits');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.permissionMode).toBe('acceptEdits');
  });

  test('parses mcpServers array', async () => {
    writeAgent('test-mcp', 'name: test-mcp\nmcpServers:\n  - brave\n  - github');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.mcpServers).toEqual(['brave', 'github']);
  });

  test('parses requiredMcpServers array', async () => {
    writeAgent('test-req', 'name: test-req\nrequiredMcpServers:\n  - linear');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.requiredMcpServers).toEqual(['linear']);
  });

  test('parses background boolean', async () => {
    writeAgent('test-bg', 'name: test-bg\nbackground: true');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.background).toBe(true);
  });

  test('parses omitClaudeMd boolean', async () => {
    writeAgent('test-omit', 'name: test-omit\nomitClaudeMd: true');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.omitClaudeMd).toBe(true);
  });

  test('parses memory string', async () => {
    writeAgent('test-mem', 'name: test-mem\nmemory: /path/to/memory.md');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.memory).toBe('/path/to/memory.md');
  });

  test('fields are all optional — minimal agent still loads', async () => {
    writeAgent('minimal', 'name: minimal\ndescription: tiny');
    const agents = await loadUserAgents(cwd, home);
    expect(agents[0]!.name).toBe('minimal');
    expect(agents[0]!.effort).toBeUndefined();
    expect(agents[0]!.permissionMode).toBeUndefined();
    expect(agents[0]!.mcpServers).toBeUndefined();
  });
});
