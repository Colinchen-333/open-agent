import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillRegistry } from '../index.js';

describe('SkillRegistry', () => {
  it('loads local markdown skills and resolves arguments', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-skills-'));
    const skillsDir = join(cwd, '.open-agent', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'review.md'),
      `---
name: review
description: Review the current change
allowed-tools: Read,Grep
---
Inspect the code touched by $ARGUMENTS and summarize the risks.`,
      'utf-8',
    );

    const registry = new SkillRegistry({ cwd });
    registry.load();

    const skills = registry.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('review');

    const resolved = registry.resolve('review', 'src/auth.ts');
    expect(resolved).not.toBeNull();
    expect(resolved?.prompt).toContain('src/auth.ts');
    expect(resolved?.allowedTools).toEqual(['Read', 'Grep']);
  });

  describe('userInvocable flag', () => {
    function makeRegistry(skills: Array<{ name: string; userInvocable?: string }>) {
      const cwd = mkdtempSync(join(tmpdir(), 'open-agent-skills-'));
      const skillsDir = join(cwd, '.open-agent', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      for (const s of skills) {
        const frontmatterLines = [`name: ${s.name}`, 'description: A test skill'];
        if (s.userInvocable !== undefined) {
          frontmatterLines.push(`user-invocable: ${s.userInvocable}`);
        }
        writeFileSync(
          join(skillsDir, `${s.name}.md`),
          `---\n${frontmatterLines.join('\n')}\n---\nDo the thing.`,
          'utf-8',
        );
      }
      const registry = new SkillRegistry({ cwd });
      registry.load();
      return registry;
    }

    it('skills without userInvocable are visible in list()', () => {
      const registry = makeRegistry([{ name: 'public-skill' }]);
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('public-skill');
      expect(entries[0].userInvocable).toBeUndefined();
    });

    it('skills with userInvocable: true are visible in list()', () => {
      const registry = makeRegistry([{ name: 'explicit-public', userInvocable: 'true' }]);
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('explicit-public');
      expect(entries[0].userInvocable).toBeUndefined();
    });

    it('skills with userInvocable: false have userInvocable=false in list()', () => {
      const registry = makeRegistry([{ name: 'internal-skill', userInvocable: 'false' }]);
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('internal-skill');
      expect(entries[0].userInvocable).toBe(false);
    });

    it('mixed: list() returns all skills but marks non-user-invocable ones', () => {
      const registry = makeRegistry([
        { name: 'public-a' },
        { name: 'internal-b', userInvocable: 'false' },
        { name: 'public-c', userInvocable: 'true' },
      ]);
      const entries = registry.list();
      expect(entries).toHaveLength(3);
      const internal = entries.find((e) => e.name === 'internal-b');
      const publicA = entries.find((e) => e.name === 'public-a');
      const publicC = entries.find((e) => e.name === 'public-c');
      expect(internal?.userInvocable).toBe(false);
      expect(publicA?.userInvocable).toBeUndefined();
      expect(publicC?.userInvocable).toBeUndefined();
    });

    it('resolve() still works for non-user-invocable skills (LLM can use them)', () => {
      const registry = makeRegistry([{ name: 'internal-skill', userInvocable: 'false' }]);
      const resolved = registry.resolve('internal-skill');
      expect(resolved).not.toBeNull();
      expect(resolved?.name).toBe('internal-skill');
    });

    it('programmatically registered skill with userInvocable: false is marked', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'open-agent-skills-'));
      const registry = new SkillRegistry({ cwd });
      registry.register({
        name: 'prog-internal',
        description: 'Internal only',
        prompt: 'Do stuff.',
        source: 'local',
        sourceLabel: 'test',
        userInvocable: false,
      });
      const entries = registry.list();
      expect(entries[0].userInvocable).toBe(false);
    });
  });
});
