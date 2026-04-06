import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkflowTool } from '../workflow-tool';
import { setFeatureDefault, clearFeatureOverrides } from '@open-agent/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'oa-workflow-'));
}

function writeWorkflowMd(base: string, name: string, content: string): void {
  const dir = join(base, '.claude', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowTool', () => {
  const roots: string[] = [];

  afterEach(() => {
    clearFeatureOverrides();
    for (const dir of roots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const d = makeTmpDir();
    roots.push(d);
    return d;
  }

  function makeCtx(cwd: string) {
    return { cwd, sessionId: 'wf-test', toolUseId: 'wf-1' } as any;
  }

  // ---- feature flag gate ----

  test('returns error when feature flag is off', async () => {
    // WORKFLOW_SCRIPTS defaults to false; no override needed
    const cwd = tmp();
    const tool = createWorkflowTool();
    const result = await tool.execute({ list: true }, makeCtx(cwd));
    expect(result.error).toContain('WORKFLOW_SCRIPTS');
  });

  // ---- list: no workflows ----

  test('list returns empty array with guidance message when no workflows exist', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    const tool = createWorkflowTool();
    const result = await tool.execute({ list: true }, makeCtx(cwd));
    expect(result.workflows).toEqual([]);
    expect(result.message).toContain('.claude/workflows/');
  });

  test('list is the default when name is omitted', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    const tool = createWorkflowTool();
    // No name, no list flag — should still list
    const result = await tool.execute({}, makeCtx(cwd));
    expect(result.workflows).toBeDefined();
  });

  // ---- list: with workflows ----

  test('list returns workflow entries with name, description, source', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    writeWorkflowMd(
      cwd,
      'deploy',
      '---\ndescription: Deploy to production\n---\n1. Run tests\n2. Push',
    );
    const tool = createWorkflowTool();
    const result = await tool.execute({ list: true }, makeCtx(cwd));
    expect(result.workflows).toHaveLength(1);
    const entry = result.workflows[0];
    expect(entry.name).toBe('deploy');
    expect(entry.description).toBe('Deploy to production');
    expect(entry.source).toBe('project');
  });

  test('list includes multiple workflows sorted alphabetically', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    writeWorkflowMd(cwd, 'zebra', '---\ndescription: Z\n---\nZ steps');
    writeWorkflowMd(cwd, 'alpha', '---\ndescription: A\n---\nA steps');
    const tool = createWorkflowTool();
    const result = await tool.execute({ list: true }, makeCtx(cwd));
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0].name).toBe('alpha');
    expect(result.workflows[1].name).toBe('zebra');
  });

  // ---- load by name ----

  test('returns workflow steps and message when found by name', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    writeWorkflowMd(
      cwd,
      'release',
      '---\ndescription: Release workflow\n---\n1. Tag commit\n2. Publish',
    );
    const tool = createWorkflowTool();
    const result = await tool.execute({ name: 'release' }, makeCtx(cwd));
    expect(result.name).toBe('release');
    expect(result.description).toBe('Release workflow');
    expect(result.steps).toContain('1. Tag commit');
    expect(result.message).toContain('release');
  });

  // ---- not found ----

  test('returns error when named workflow does not exist', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    writeWorkflowMd(cwd, 'existing', '---\ndescription: Exists\n---\nBody');
    const tool = createWorkflowTool();
    const result = await tool.execute({ name: 'missing' }, makeCtx(cwd));
    expect(result.error).toContain('"missing"');
    expect(result.error).toContain('existing');
  });

  test('not found error lists "none" when no workflows are available', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    const tool = createWorkflowTool();
    const result = await tool.execute({ name: 'ghost' }, makeCtx(cwd));
    expect(result.error).toContain('"ghost"');
    expect(result.error).toContain('none');
  });

  // ---- description missing from frontmatter ----

  test('description defaults to empty string when frontmatter has no description', async () => {
    setFeatureDefault('WORKFLOW_SCRIPTS', true);
    const cwd = tmp();
    writeWorkflowMd(cwd, 'no-desc', 'No frontmatter at all.\nJust steps.');
    const tool = createWorkflowTool();
    const listResult = await tool.execute({ list: true }, makeCtx(cwd));
    expect(listResult.workflows[0].description).toBe('');

    const loadResult = await tool.execute({ name: 'no-desc' }, makeCtx(cwd));
    expect(loadResult.description).toBe('');
    expect(loadResult.steps).toContain('No frontmatter at all.');
  });
});
