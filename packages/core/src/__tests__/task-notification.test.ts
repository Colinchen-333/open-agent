import { describe, expect, it } from 'bun:test';
import { buildTaskOrchestrationTemplates } from '../task-notification.js';

describe('buildTaskOrchestrationTemplates', () => {
  it('returns resume and verification templates for completed tasks', () => {
    const templates = buildTaskOrchestrationTemplates({
      taskId: 'worker-1',
      status: 'completed',
      description: 'auth-worker',
      summary: 'Worker finished auth fix',
      result: 'Updated src/auth.ts and ran bun test.',
    });

    expect(templates.resume_prompt_template).toContain('task worker-1');
    expect(templates.verification_prompt_template).toContain('Claims to verify');
    expect(templates.retry_prompt_template).toBeUndefined();
  });

  it('returns retry template for failed tasks', () => {
    const templates = buildTaskOrchestrationTemplates({
      taskId: 'worker-2',
      status: 'failed',
      summary: 'Test failure in auth flow',
      result: 'Expected 200 but got 500.',
    });

    expect(templates.retry_prompt_template).toContain('Failure context');
    expect(templates.resume_prompt_template).toBeUndefined();
    expect(templates.verification_prompt_template).toBeUndefined();
  });

  it('returns resume template for stopped tasks', () => {
    const templates = buildTaskOrchestrationTemplates({
      taskId: 'worker-3',
      status: 'stopped',
      summary: 'Stopped after partial migration work',
    });

    expect(templates.resume_prompt_template).toContain('Interrupted context');
    expect(templates.retry_prompt_template).toBeUndefined();
  });
});
