import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query } from '../query.js';

describe('query() team inbox control plane', () => {
  it('supports acknowledge, unread filtering, and after cursors', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-team-inbox-control-'));

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
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(1);

      expect(
        await q.acknowledgeTeamInbox({
          teamName,
          memberName: 'alice',
          messageIds: [peeked[0]!.messageId!],
        }),
      ).toEqual({ acknowledged: 1 });
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(0);

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
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
