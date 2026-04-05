import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { TeamManager } from '../team-manager.js';

function makeTempHome(prefix: string): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  return {
    root,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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
