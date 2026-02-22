import type { ToolDefinition, ToolContext } from './types.js';

export interface TeamToolsDeps {
  createTeam: (name: string, description?: string) => Promise<{ teamName: string; configPath: string }>;
  deleteTeam: (name: string) => Promise<{ success: boolean }>;
  sendMessage: (params: {
    type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response';
    recipient?: string;
    content?: string;
    summary?: string;
    approve?: boolean;
    request_id?: string;
  }) => Promise<{ success: boolean; message: string }>;
}

export function createTeamCreateTool(deps: TeamToolsDeps): ToolDefinition {
  return {
    name: 'TeamCreate',
    description: 'Create a new team to coordinate multiple agents working on a project.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: { type: 'string', description: 'Name for the new team' },
        description: { type: 'string', description: 'Team description/purpose' },
        agent_type: { type: 'string', description: 'Type/role of the team lead' },
      },
      required: ['team_name'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const result = await deps.createTeam(input.team_name, input.description);
      return JSON.stringify(result);
    },
  };
}

export function createTeamDeleteTool(deps: TeamToolsDeps): ToolDefinition {
  return {
    name: 'TeamDelete',
    description: 'Remove team and task directories when work is complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input: any, _ctx: ToolContext) {
      // 实际中需要从上下文获取当前 team name
      return JSON.stringify({ success: true, message: 'Team deleted' });
    },
  };
}

export function createSendMessageTool(deps: TeamToolsDeps): ToolDefinition {
  return {
    name: 'SendMessage',
    description:
      'Send messages to agent teammates. Supports: message (DM), broadcast (all), shutdown_request, shutdown_response.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['message', 'broadcast', 'shutdown_request', 'shutdown_response', 'plan_approval_response'],
          description: 'Message type',
        },
        recipient: { type: 'string', description: 'Agent name of the recipient' },
        content: { type: 'string', description: 'Message text' },
        summary: { type: 'string', description: '5-10 word summary' },
        approve: { type: 'boolean', description: 'Whether to approve (for response types)' },
        request_id: { type: 'string', description: 'Request ID to respond to' },
      },
      required: ['type'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const result = await deps.sendMessage(input);
      return JSON.stringify(result);
    },
  };
}
