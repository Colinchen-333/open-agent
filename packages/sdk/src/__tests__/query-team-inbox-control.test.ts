import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { TeamManager } from '@open-agent/agents';
import { query } from '../query.js';
import { makeLockedTempHome } from './temp-home.js';

describe('query() team inbox control plane', () => {
  it('supports acknowledge, unread filtering, and after cursors', async () => {
    const temp = makeLockedTempHome('open-agent-sdk-team-inbox-control-');
    const cwd = temp.cwd;

    try {
      const q = query('team inbox control', { cwd, model: 'claude-sonnet-4-6' });
      const teamName = `alpha-${Date.now()}`;
      await q.createTeam({ name: teamName });

      await q.sendTeamMessage({
        teamName,
        type: 'shutdown_request',
        recipient: 'alice',
        content: 'Please stop after finishing the current step.',
        summary: 'shutdown alice',
      });

      const peeked = await q.readTeamInbox({ teamName, memberName: 'alice', consume: false });
      expect(peeked).toHaveLength(1);
      expect(peeked[0]?.messageId).toBeTruthy();
      const peekedAgain = await q.readTeamInbox({ teamName, memberName: 'alice', consume: false });
      expect(peekedAgain).toEqual(peeked);
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(1);
      const stateAfterPeek = (q as any).__internal_getAppState?.();
      expect(stateAfterPeek?.inboxes[teamName]?.['alice']?.unreadCount).toBe(1);
      expect(stateAfterPeek?.approvals[teamName]?.['alice']).toHaveLength(1);

      expect(
        await q.acknowledgeTeamInbox({
          teamName,
          memberName: 'alice',
          messageIds: [peeked[0]!.messageId!],
        }),
      ).toEqual({ acknowledged: 1 });
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(0);
      const stateAfterAck = (q as any).__internal_getAppState?.();
      expect(stateAfterAck?.inboxes[teamName]?.['alice']?.unreadCount).toBe(0);
      expect(stateAfterAck?.approvals[teamName]?.['alice']?.[0]?.readAt).toBeTruthy();

      const unreadOnly = await q.readTeamInbox({
        teamName,
        memberName: 'alice',
        consume: false,
        unreadOnly: true,
      });
      expect(unreadOnly).toHaveLength(0);

      await q.sendTeamMessage({
        teamName,
        type: 'message',
        recipient: 'alice',
        content: 'Second inbox message.',
      });
      const afterFirst = await q.readTeamInbox({
        teamName,
        memberName: 'alice',
        consume: false,
        after: peeked[0]!.messageId,
      });
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]?.content).toBe('Second inbox message.');

      const consumed = await q.readTeamInbox({ teamName, memberName: 'alice', consume: true });
      expect(consumed).toHaveLength(2);
      expect(consumed[0]?.content).toContain('Please stop');
      expect(consumed[1]?.content).toBe('Second inbox message.');
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(0);
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('refreshes store-first inbox and approval reads when external inbox writes arrive', async () => {
    const temp = makeLockedTempHome('open-agent-sdk-team-inbox-external-refresh-');
    const cwd = temp.cwd;

    try {
      const q = query('team inbox external refresh', { cwd, model: 'claude-sonnet-4-6' });
      const teamName = `gamma-${Date.now()}`;
      await q.createTeam({ name: teamName });

      const teamManager = new TeamManager({
        baseDir: join(cwd, '.open-agent', 'teams'),
        taskBaseDir: join(cwd, '.open-agent', 'tasks'),
      });
      teamManager.sendMessage(teamName, {
        type: 'plan_approval_request',
        from: 'worker-1',
        to: 'lead',
        content: 'Approve the first change.',
        summary: 'first approval',
        timestamp: new Date().toISOString(),
        requestId: 'req-1',
      });

      const firstRead = await q.readTeamInbox({
        teamName,
        memberName: 'lead',
        consume: false,
      });
      expect(firstRead).toHaveLength(1);
      expect(await q.listPendingTeamApprovals({ teamName, memberName: 'lead' })).toHaveLength(1);

      teamManager.sendMessage(teamName, {
        type: 'plan_approval_request',
        from: 'worker-2',
        to: 'lead',
        content: 'Approve the second change.',
        summary: 'second approval',
        timestamp: new Date().toISOString(),
        requestId: 'req-2',
      });

      const refreshedRead = await q.readTeamInbox({
        teamName,
        memberName: 'lead',
        consume: false,
      });
      expect(refreshedRead).toHaveLength(2);
      expect(await q.getTeamInboxCount('lead', { teamName })).toBe(2);
      expect(await q.listPendingTeamApprovals({ teamName, memberName: 'lead' })).toHaveLength(2);
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
