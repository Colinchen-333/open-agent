import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query } from '../query.js';

describe('query() team approval control plane', () => {
  it('lists and responds to pending team approvals', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-team-approval-control-'));

    try {
      const q = query('team approval control', { cwd, model: 'claude-sonnet-4-6' });
      const teamName = `alpha-${Date.now()}`;
      await q.createTeam({ name: teamName });

      const request = await q.sendTeamMessage({
        teamName,
        type: 'plan_approval_request',
        from: 'worker-1',
        recipient: 'lead',
        content: 'Approve the planned refactor.',
        summary: 'plan approval',
      });
      expect(request.requestId).toBeTruthy();

      const pending = await q.listPendingTeamApprovals({
        teamName,
        memberName: 'lead',
        unreadOnly: true,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestType).toBe('plan_approval_request');

      const response = await q.respondToTeamApproval({
        teamName,
        memberName: 'lead',
        messageId: pending[0]!.messageId,
        approve: true,
        from: 'team-lead',
        feedback: 'Proceed with the refactor.',
      });
      expect(response.acknowledged).toBe(1);
      expect(response.request.requestId).toBe(request.requestId);
      expect(response.response.type).toBe('plan_approval_response');
      expect(response.response.approve).toBe(true);

      const workerInbox = await q.readTeamInbox({ teamName, memberName: 'worker-1', consume: false });
      expect(
        workerInbox.some(
          (message) =>
            message.type === 'plan_approval_response'
            && message.requestId === request.requestId
            && message.approve === true,
        ),
      ).toBe(true);
      expect(
        await q.listPendingTeamApprovals({
          teamName,
          memberName: 'lead',
          unreadOnly: true,
        }),
      ).toHaveLength(0);
      q.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('supports requestId lookups and shutdown approval responses', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-team-shutdown-approval-'));

    try {
      const q = query('team shutdown approval control', { cwd, model: 'claude-sonnet-4-6' });
      const teamName = `beta-${Date.now()}`;
      await q.createTeam({ name: teamName });

      const request = await q.sendTeamMessage({
        teamName,
        type: 'shutdown_request',
        from: 'lead',
        recipient: 'worker-2',
        content: 'Please stop after the current task.',
        summary: 'shutdown worker-2',
      });

      const pending = await q.listPendingTeamApprovals({
        teamName,
        memberName: 'worker-2',
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestType).toBe('shutdown_request');

      const response = await q.respondToTeamApproval({
        teamName,
        memberName: 'worker-2',
        requestId: request.requestId,
        approve: false,
        feedback: 'Need more time to finish cleanup.',
        acknowledge: false,
      });
      expect(response.acknowledged).toBe(0);
      expect(response.response.type).toBe('shutdown_response');
      expect(response.response.approve).toBe(false);

      const leadInbox = await q.readTeamInbox({ teamName, memberName: 'lead', consume: true });
      expect(leadInbox).toHaveLength(1);
      expect(leadInbox[0]?.type).toBe('shutdown_response');
      expect(leadInbox[0]?.approve).toBe(false);

      const stillPending = await q.listPendingTeamApprovals({
        teamName,
        memberName: 'worker-2',
        unreadOnly: true,
      });
      expect(stillPending).toHaveLength(1);
      q.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
