import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AutoMemory } from '../auto-memory.js';
import { loadPromptContext, type PromptContextProvider } from '../context-providers.js';
import { makeLockedTempHome } from '../../../sdk/src/__tests__/temp-home.js';

describe('loadPromptContext', () => {
  let testRoot: string;
  let tempHome: { cwd: string; cleanup(): void };

  beforeEach(() => {
    tempHome = makeLockedTempHome('open-agent-context-');
    testRoot = tempHome.cwd;
  });

  afterEach(() => {
    tempHome.cleanup();
  });

  it('loads git/memory/additional-directory sections and compatibility fields', () => {
    const cwd = join(testRoot, 'project');
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'README.md'), '# test');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    mkdirSync(join(cwd, '.open-agent'), { recursive: true });
    writeFileSync(join(cwd, 'AGENT.md'), 'project instructions');

    mkdirSync(join(process.env.HOME!, '.open-agent'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.open-agent', 'AGENT.md'), 'user instructions');

    const memory = new AutoMemory(cwd);
    memory.writeMemory('remember this');

    const snapshot = loadPromptContext({
      cwd,
      includeGit: true,
      includeMemory: true,
      includeAgentInstructions: true,
      additionalDirectories: ['/tmp/one', '/tmp/two'],
    });

    expect(snapshot.gitContext).toBeTruthy();
    expect(snapshot.memoryDir).toContain('.open-agent');
    expect(snapshot.memoryContent).toContain('remember this');
    expect(snapshot.agentInstructions).toContain('project instructions');

    const sectionKeys = snapshot.sections.map((section) => section.key);
    expect(sectionKeys).toContain('git-context');
    expect(sectionKeys).toContain('memory-context');
    expect(sectionKeys).toContain('additional-working-directories');

    const additionalDirsSection = snapshot.sections.find(
      (section) => section.key === 'additional-working-directories',
    );
    expect(additionalDirsSection?.content).toContain('/tmp/one');
    expect(additionalDirsSection?.content).toContain('/tmp/two');
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

  it('supports custom prompt context providers for extension', () => {
    const customProvider: PromptContextProvider = {
      key: 'custom',
      provide() {
        return {
          sections: [
            {
              key: 'custom-section',
              title: 'Custom Section',
              content: 'custom content',
            },
          ],
        };
      },
    };

    const snapshot = loadPromptContext(
      { cwd: testRoot },
      [customProvider],
    );

    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.sections[0]).toEqual({
      key: 'custom-section',
      title: 'Custom Section',
      content: 'custom content',
    });
    expect(snapshot.agentInstructions).toEqual([]);
  });
});
