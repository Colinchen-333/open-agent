import { describe, expect, it } from 'bun:test';
import { classifyBashCommand } from '../bash-risk.js';

describe('classifyBashCommand', () => {
  it('classifies simple inspection commands as read-only', () => {
    expect(classifyBashCommand('git status')).toMatchObject({
      level: 'read-only',
      categories: ['git-read'],
    });
    expect(classifyBashCommand('rg TODO src')).toMatchObject({
      level: 'read-only',
      categories: ['search'],
    });
  });

  it('classifies project mutations as workspace-write', () => {
    expect(classifyBashCommand('npm test')).toMatchObject({
      level: 'workspace-write',
      categories: ['script-exec'],
    });
    expect(classifyBashCommand('mkdir -p tmp/output')).toMatchObject({
      level: 'workspace-write',
      categories: ['workspace-write'],
    });
  });

  it('classifies network operations separately', () => {
    expect(classifyBashCommand('git fetch origin')).toMatchObject({
      level: 'network',
      categories: ['network'],
    });
    expect(classifyBashCommand('curl https://example.com')).toMatchObject({
      level: 'network',
      categories: ['network'],
    });
  });

  it('classifies destructive commands as destructive', () => {
    expect(classifyBashCommand('rm -rf dist')).toMatchObject({
      level: 'destructive',
      categories: ['delete'],
    });
    expect(classifyBashCommand('sudo apt update')).toMatchObject({
      level: 'system',
      categories: ['privileged'],
    });
  });
});
