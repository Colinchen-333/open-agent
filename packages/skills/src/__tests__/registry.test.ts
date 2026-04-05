import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillRegistry, loadUserSkills, augmentRegistryWithUserSkills } from '../index.js';

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

describe('loadUserSkills', () => {
  function makeTempDir() {
    return mkdtempSync(join(tmpdir(), 'open-agent-user-skills-'));
  }

  it('loads a skill from <cwd>/.claude/skills/', async () => {
    const cwd = makeTempDir();
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'test-skill.md'),
      `---
name: test-skill
description: A test skill loaded from markdown
---
Do the thing with $ARGUMENTS.`,
      'utf-8',
    );

    const skills = await loadUserSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
    expect(skills[0].description).toBe('A test skill loaded from markdown');
    expect(skills[0].prompt).toContain('Do the thing with $ARGUMENTS.');
    expect(skills[0].source).toBe('local');
  });

  it('uses filename stem as name when frontmatter name is absent', async () => {
    const cwd = makeTempDir();
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'auto-named.md'),
      `---
description: No explicit name
---
Prompt body here.`,
      'utf-8',
    );

    const skills = await loadUserSkills(cwd);
    expect(skills[0].name).toBe('auto-named');
  });

  it('sets userInvocable: false when frontmatter says false', async () => {
    const cwd = makeTempDir();
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'hidden-skill.md'),
      `---
name: hidden-skill
description: Internal skill
user-invocable: false
---
Internal prompt.`,
      'utf-8',
    );

    const skills = await loadUserSkills(cwd);
    expect(skills).toHaveLength(1);
    expect(skills[0].userInvocable).toBe(false);
  });

  it('leaves userInvocable undefined when frontmatter omits it', async () => {
    const cwd = makeTempDir();
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'public-skill.md'),
      `---
name: public-skill
description: No userInvocable field
---
Prompt.`,
      'utf-8',
    );

    const skills = await loadUserSkills(cwd);
    expect(skills[0].userInvocable).toBeUndefined();
  });

  it('returns empty array when no .claude/skills directory exists', async () => {
    const cwd = makeTempDir();
    const skills = await loadUserSkills(cwd);
    expect(skills).toHaveLength(0);
  });

  it('project layer overrides user layer for same name', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();

    const userSkillsDir = join(home, '.claude', 'skills');
    const projectSkillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(userSkillsDir, { recursive: true });
    mkdirSync(projectSkillsDir, { recursive: true });

    writeFileSync(
      join(userSkillsDir, 'shared.md'),
      `---\nname: shared\ndescription: User version\n---\nUser prompt.`,
      'utf-8',
    );
    writeFileSync(
      join(projectSkillsDir, 'shared.md'),
      `---\nname: shared\ndescription: Project version\n---\nProject prompt.`,
      'utf-8',
    );

    const skills = await loadUserSkills(cwd, home);
    // Only one entry for "shared", and it should be the project version
    const sharedSkills = skills.filter((s) => s.name === 'shared');
    expect(sharedSkills).toHaveLength(1);
    expect(sharedSkills[0].description).toBe('Project version');
  });
});

describe('augmentRegistryWithUserSkills', () => {
  it('augments registry with user skills, overriding same-named bundled skill', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-augment-'));
    const registry = new SkillRegistry({ cwd });

    // Register a bundled skill
    registry.register({
      name: 'shared-skill',
      description: 'Bundled version',
      prompt: 'Bundled prompt.',
      source: 'local',
      sourceLabel: 'bundled',
    });

    // Add a user skill with the same name in .claude/skills/
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'shared-skill.md'),
      `---\nname: shared-skill\ndescription: User override\n---\nUser prompt.`,
      'utf-8',
    );

    await augmentRegistryWithUserSkills(registry, cwd);

    const resolved = registry.resolve('shared-skill');
    expect(resolved).not.toBeNull();
    expect(resolved?.description).toBe('User override');
    expect(resolved?.prompt).toContain('User prompt.');
  });

  it('adds new skills not already present in registry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-augment-new-'));
    const registry = new SkillRegistry({ cwd });

    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'new-skill.md'),
      `---\nname: new-skill\ndescription: Brand new\n---\nNew prompt.`,
      'utf-8',
    );

    await augmentRegistryWithUserSkills(registry, cwd);

    const entries = registry.list();
    const found = entries.find((e) => e.name === 'new-skill');
    expect(found).toBeDefined();
    expect(found?.description).toBe('Brand new');
  });
});
