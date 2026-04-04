import { describe, expect, it } from 'bun:test';
import {
  createSendMessageTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  type TeamToolsDeps,
} from '../team-tools.js';
import type { ToolContext } from '../types.js';

const ctx: ToolContext = {
  cwd: '/tmp/project',
  sessionId: 'session-team-tools',
};

function makeDeps(overrides?: Partial<TeamToolsDeps>): TeamToolsDeps {
  return {
    createTeam: async (name: string) => ({
      teamName: name,
      configPath: `/tmp/teams/${name}/config.json`,
      scratchpadPath: `/tmp/teams/${name}/scratchpad`,
    }),
    deleteTeam: async () => ({ success: true }),
    getActiveTeam: () => 'alpha-team',
    sendMessage: async () => ({ success: true, message: 'Message sent' }),
    ...overrides,
  };
}

describe('team tools', () => {
  it('TeamCreate returns scratchpad metadata from deps', async () => {
    const tool = createTeamCreateTool(makeDeps());
    const result = await tool.execute({ team_name: 'alpha-team' }, ctx);

    expect(result).toContain('"teamName":"alpha-team"');
    expect(result).toContain('"scratchpadPath":"/tmp/teams/alpha-team/scratchpad"');
  });

  it('TeamDelete uses active team from session context', async () => {
    let deletedTeam: string | undefined;
    const tool = createTeamDeleteTool(makeDeps({
      deleteTeam: async (name: string) => {
        deletedTeam = name;
        return { success: true };
      },
      getActiveTeam: () => 'beta-team',
    }));

    await tool.execute({}, ctx);

    expect(deletedTeam).toBe('beta-team');
  });

  it('SendMessage validates recipient for direct messages', async () => {
    const tool = createSendMessageTool(makeDeps());
    const result = await tool.execute({ type: 'message', content: 'hello' }, ctx);

    expect(result).toContain('recipient is required');
  });

  it('SendMessage passes through routing result', async () => {
    const tool = createSendMessageTool(makeDeps({
      sendMessage: async ({ recipient, summary }) => ({
        success: true,
        message: 'Message sent',
        routing: {
          target: recipient,
          summary,
        },
      }),
    }));

    const result = await tool.execute({
      type: 'message',
      recipient: 'reviewer',
      content: 'Please verify the fix',
      summary: 'Verify auth fix',
    }, ctx);

    expect(result).toContain('"target":"reviewer"');
    expect(result).toContain('"summary":"Verify auth fix"');
  });

  it('provides concise tool-use summaries', () => {
    const teamCreate = createTeamCreateTool(makeDeps());
    const teamDelete = createTeamDeleteTool(makeDeps());
    const sendMessage = createSendMessageTool(makeDeps());

    expect(teamCreate.getToolUseSummary?.({ team_name: 'alpha-team' }, '', false)).toBe('Created team alpha-team');
    expect(teamDelete.getToolUseSummary?.({}, '', false)).toBe('Deleted active team');
    expect(sendMessage.getToolUseSummary?.({
      type: 'message',
      recipient: 'reviewer',
      summary: 'Verify auth fix',
    }, '', false)).toBe('Messaged reviewer: Verify auth fix');
  });
});
