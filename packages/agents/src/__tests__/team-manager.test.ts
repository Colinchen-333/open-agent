import { describe, expect, it } from 'bun:test';
import { readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { TeamManager } from '../team-manager.js';
import { makeLockedTempHome as makeTempHome } from '../../../sdk/src/__tests__/temp-home.js';

describe('TeamManager inbox consumption', () => {
  it('skips inbox files that were already claimed by another consumer', () => {
    const temp = makeTempHome('open-agent-team-manager-');
    const teamName = `alpha-${randomUUID().slice(0, 8)}`;
    try {
      const manager = new TeamManager();
      manager.createTeam(teamName);
      manager.addMember(teamName, {
        name: 'lead',
        agentId: 'lead-agent',
        agentType: 'worker',
        status: 'active',
      });
      manager.sendMessage(teamName, {
        type: 'message',
        from: 'worker',
        to: 'lead',
        content: 'first',
        timestamp: new Date().toISOString(),
      });

      const inboxDir = join(manager.getTeamDir(teamName), 'inboxes', 'lead');
      const [firstFile] = readdirSync(inboxDir).filter((entry) => entry.endsWith('.json') && !entry.startsWith('.'));
      expect(firstFile).toBeTruthy();

      renameSync(
        join(inboxDir, firstFile!),
        join(inboxDir, `.claim-test-${firstFile!}`),
      );

      expect(manager.readInboxEntries(teamName, 'lead', { consume: true })).toEqual([]);

      manager.sendMessage(teamName, {
        type: 'message',
        from: 'worker',
        to: 'lead',
        content: 'second',
        timestamp: new Date().toISOString(),
      });

      const consumed = manager.readInboxEntries(teamName, 'lead', { consume: true });
      expect(consumed).toHaveLength(1);
      expect(consumed[0]?.message.content).toBe('second');
      expect(readdirSync(inboxDir).some((entry) => entry === '.claim-test-' + firstFile)).toBe(true);
    } finally {
      new TeamManager().deleteTeam(teamName);
      temp.cleanup();
    }
  });
});
