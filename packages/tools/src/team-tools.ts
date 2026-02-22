import type { ToolDefinition, ToolContext } from './types.js';

export interface TeamToolsDeps {
  createTeam: (name: string, description?: string) => Promise<{ teamName: string; configPath: string }>;
  deleteTeam: (name: string) => Promise<{ success: boolean }>;
  sendMessage: (params: {
    type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response' | 'plan_approval_request';
    recipient?: string;
    content?: string;
    summary?: string;
    approve?: boolean;
    request_id?: string;
  }) => Promise<{ success: boolean; message: string; routing?: Record<string, unknown> }>;
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
    inputSchema: {
      type: 'object',
      properties: {
        team_name: { type: 'string', description: 'Name of the team to delete' },
      },
      required: ['team_name'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const result = await deps.deleteTeam(input.team_name);
      return JSON.stringify(result);
    },
  };
}

export function createSendMessageTool(deps: TeamToolsDeps): ToolDefinition {
  return {
    name: 'SendMessage',
    description: `Send messages to agent teammates and handle protocol requests/responses in a team.

Message types:
- "message"                → DM to a specific teammate (recipient required)
- "broadcast"              → send to ALL teammates at once (use sparingly)
- "shutdown_request"       → ask a teammate to gracefully shut down
- "shutdown_response"      → approve or reject a shutdown request (request_id + approve required)
- "plan_approval_response" → approve or reject a teammate's plan (request_id + approve required)
- "plan_approval_request"  → send a plan for approval (recipient required)`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'message',
            'broadcast',
            'shutdown_request',
            'shutdown_response',
            'plan_approval_response',
            'plan_approval_request',
          ],
          description: 'Message type',
        },
        recipient: {
          type: 'string',
          description: 'Agent name of the recipient (required for message, shutdown_request, plan_approval_response, plan_approval_request)',
        },
        content: {
          type: 'string',
          description: 'Message text or reason',
        },
        summary: {
          type: 'string',
          description: '5-10 word summary shown as preview in the UI (required for message, broadcast)',
        },
        approve: {
          type: 'boolean',
          description: 'Whether to approve the request (required for shutdown_response, plan_approval_response)',
        },
        request_id: {
          type: 'string',
          description: 'Request ID to respond to (required for shutdown_response, plan_approval_response)',
        },
      },
      required: ['type'],
    },
    async execute(input: any, _ctx: ToolContext) {
      // Validate required fields per message type.
      const { type, recipient, approve, request_id, content, summary } = input;

      if (type === 'message' && !recipient) {
        return JSON.stringify({ success: false, error: 'recipient is required for type "message"' });
      }
      if (type === 'shutdown_request' && !recipient) {
        return JSON.stringify({ success: false, error: 'recipient is required for type "shutdown_request"' });
      }
      if ((type === 'shutdown_response' || type === 'plan_approval_response') && !request_id) {
        return JSON.stringify({ success: false, error: `request_id is required for type "${type}"` });
      }
      if ((type === 'shutdown_response' || type === 'plan_approval_response') && approve === undefined) {
        return JSON.stringify({ success: false, error: `approve is required for type "${type}"` });
      }
      if (type === 'plan_approval_request' && !recipient) {
        return JSON.stringify({ success: false, error: 'recipient is required for type "plan_approval_request"' });
      }

      const result = await deps.sendMessage({
        type,
        recipient,
        content,
        summary,
        approve,
        request_id,
      });

      return JSON.stringify(result);
    },
  };
}
