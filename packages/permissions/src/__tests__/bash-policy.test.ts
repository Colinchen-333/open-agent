import { describe, expect, it } from 'bun:test';
import { classifyBashCommand } from '../bash-policy.js';

describe('classifyBashCommand policy chains', () => {
  it('treats read-only command chains as read-only', () => {
    expect(classifyBashCommand('git status && rg TODO src')).toEqual({
      level: 'read-only',
      reason: 'read-only command chain',
      categories: ['inspection', 'chain'],
    });
  });

  it('treats mixed local chains as workspace writes', () => {
    expect(classifyBashCommand('git status && mkdir -p tmp/output')).toEqual({
      level: 'workspace-write',
      reason: 'workspace mutation command chain',
      categories: ['workspace-write', 'chain'],
    });
  });

  it('keeps elevated network and system commands elevated inside chains', () => {
    expect(classifyBashCommand('git status && curl https://example.com')).toMatchObject({
      level: 'network',
      reason: 'network fetch',
    });
    expect(classifyBashCommand('git status && sudo npm install')).toMatchObject({
      level: 'system',
      reason: 'privilege escalation',
    });
  });
});
