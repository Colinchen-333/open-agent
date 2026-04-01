import { describe, expect, it } from 'bun:test';
import { classifyBashCommand } from '../bash-risk.js';

describe('classifyBashCommand', () => {
  it('classifies read-only commands', () => {
    expect(classifyBashCommand('git diff --stat').level).toBe('read-only');
    expect(classifyBashCommand('rg TODO src').level).toBe('read-only');
  });

  it('classifies local mutating commands', () => {
    expect(classifyBashCommand('mkdir -p build').level).toBe('workspace-write');
    expect(classifyBashCommand('npm test').level).toBe('workspace-write');
  });

  it('classifies network commands', () => {
    expect(classifyBashCommand('curl https://example.com').level).toBe('network');
    expect(classifyBashCommand('git clone https://example.com/repo.git').level).toBe('network');
  });

  it('classifies destructive commands', () => {
    expect(classifyBashCommand('rm -rf dist').level).toBe('destructive');
    expect(classifyBashCommand('git push origin main').level).toBe('destructive');
  });
});
