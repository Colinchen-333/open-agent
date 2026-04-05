import { describe, expect, it } from 'bun:test';
import { buildCoordinatorContext } from '../coordinator-context.js';

describe('buildCoordinatorContext', () => {
  it('normalizes worker tools and derives recent recovery hints from task notifications', () => {
    const context = buildCoordinatorContext({
      workerTools: ['Bash', 'Read', 'Bash', ''],
      activeTeam: 'platform',
      scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
      canUseSkills: true,
      canUseMcpTools: true,
      taskNotifications: [
        {
          task_id: 'worker-2',
          status: 'failed',
          completed_at: '2026-04-05T12:00:00.000Z',
          orchestration_templates: {
            retry_prompt_template: 'Duplicate fingerprint should be removed.',
          },
        },
        {
          task_id: 'worker-1',
          status: 'completed',
          description: 'Initial pass',
          completed_at: '2026-04-05T10:00:00.000Z',
          orchestration_templates: {
            verification_prompt_template: 'Verify the changed files.',
          },
        },
        {
          task_id: 'worker-2',
          status: 'failed',
          team_name: 'platform',
          description: 'Refactor billing flow',
          summary: 'Timed out on migration tests',
          completed_at: '2026-04-05T12:00:00.000Z',
          orchestration_templates: {
            retry_prompt_template: 'Retry with a narrower scope.',
            resume_prompt_template: 'Resume from the last failing test.',
          },
        },
      ],
    });

    expect(context).toEqual({
      workerTools: ['Bash', 'Read'],
      activeTeam: 'platform',
      scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
      canUseSkills: true,
      canUseMcpTools: true,
      recoveryHints: [
        {
          taskId: 'worker-2',
          status: 'failed',
          teamName: 'platform',
          description: 'Refactor billing flow',
          summary: 'Timed out on migration tests',
          completedAt: '2026-04-05T12:00:00.000Z',
          retryPromptTemplate: 'Retry with a narrower scope.',
          resumePromptTemplate: 'Resume from the last failing test.',
        },
        {
          taskId: 'worker-1',
          status: 'completed',
          description: 'Initial pass',
          completedAt: '2026-04-05T10:00:00.000Z',
          verificationPromptTemplate: 'Verify the changed files.',
        },
      ],
    });
  });

  it('returns undefined when no coordinator signal is available', () => {
    expect(buildCoordinatorContext({})).toBeUndefined();
  });
});
