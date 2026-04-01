import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPromptContext } from '../context-providers.js';

describe('loadPromptContext', () => {
  const originalHome = process.env.HOME;
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `open-agent-context-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    process.env.HOME = join(testRoot, 'home');
    mkdirSync(process.env.HOME!, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('loads git context, memory, agent instructions, and extra directories', () => {
    const cwd = join(testRoot, 'project');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, '.open-agent'), { recursive: true });
    writeFileSync(join(cwd, 'AGENT.md'), 'project instructions');

    mkdirSync(join(process.env.HOME!, '.open-agent'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.open-agent', 'AGENT.md'), 'user instructions');

    const memoryDir = join(process.env.HOME!, '.open-agent', 'projects', 'tmp-open-agent-context-memory', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    const snapshot = loadPromptContext({
      cwd,
      includeMemory: true,
      includeAgentInstructions: true,
      additionalDirectories: ['/tmp/one', '/tmp/two'],
    });

    expect(snapshot.memoryDir).toContain('.open-agent');
    expect(snapshot.agentInstructions).toContain('project instructions');
    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.sections[0]?.content).toContain('/tmp/one');
    expect(snapshot.sections[0]?.content).toContain('/tmp/two');
  });

  it('filters user instructions when only project sources are requested', () => {
    const cwd = join(testRoot, 'workspace');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AGENT.md'), 'project instructions');

    mkdirSync(join(process.env.HOME!, '.open-agent'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.open-agent', 'AGENT.md'), 'user instructions');

    const snapshot = loadPromptContext({
      cwd,
      includeAgentInstructions: true,
      instructionSources: ['project'],
    });

    expect(snapshot.agentInstructions).toEqual(['project instructions']);
  });
});
