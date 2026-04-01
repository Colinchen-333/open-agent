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
});
