import type { ToolDefinition, ToolContext } from './types.js';
import { withToolDefaults } from './tool-defaults.js';

export interface RemoteTriggerDeps {
  /** Base URL for the triggers API (e.g., "https://api.example.com/v1/code/triggers") */
  baseUrl: string;
  /** Returns an auth header value (e.g., "Bearer xxx") */
  getAuthHeader: () => Promise<string | null>;
}

export function createRemoteTriggerTool(deps: RemoteTriggerDeps): ToolDefinition {
  return withToolDefaults({
    name: 'RemoteTrigger',
    description:
      'Manage scheduled remote agent triggers via REST API. Use this instead of curl — auth is handled in-process.',
    shouldDefer: true,
    isReadOnly: false, // varies by action, but we mark false for safety
    capability: { category: 'remote' },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'run'],
          description: 'API action to perform',
        },
        trigger_id: {
          type: 'string',
          description: 'Trigger ID (required for get, update, run)',
        },
        body: {
          type: 'object',
          description: 'JSON body for create/update',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
    async execute(input: any, ctx: ToolContext) {
      const { action, trigger_id, body } = input;

      const authHeader = await deps.getAuthHeader();
      if (!authHeader) {
        return {
          status: 401,
          json: '{"error":"Not authenticated. Configure auth and try again."}',
        };
      }

      const headers: Record<string, string> = {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      };

      let method: string;
      let url: string;
      let reqBody: string | undefined;

      switch (action) {
        case 'list':
          method = 'GET';
          url = deps.baseUrl;
          break;
        case 'get':
          if (!trigger_id)
            return { status: 400, json: '{"error":"get requires trigger_id"}' };
          method = 'GET';
          url = `${deps.baseUrl}/${trigger_id}`;
          break;
        case 'create':
          if (!body)
            return { status: 400, json: '{"error":"create requires body"}' };
          method = 'POST';
          url = deps.baseUrl;
          reqBody = JSON.stringify(body);
          break;
        case 'update':
          if (!trigger_id)
            return { status: 400, json: '{"error":"update requires trigger_id"}' };
          if (!body)
            return { status: 400, json: '{"error":"update requires body"}' };
          method = 'POST';
          url = `${deps.baseUrl}/${trigger_id}`;
          reqBody = JSON.stringify(body);
          break;
        case 'run':
          if (!trigger_id)
            return { status: 400, json: '{"error":"run requires trigger_id"}' };
          method = 'POST';
          url = `${deps.baseUrl}/${trigger_id}/run`;
          reqBody = '{}';
          break;
        default:
          return {
            status: 400,
            json: `{"error":"Unknown action: ${action}"}`,
          };
      }

      const signal = ctx.abortSignal;
      const fetchOpts: RequestInit = { method, headers, signal };
      if (reqBody) fetchOpts.body = reqBody;

      try {
        const res = await fetch(url, fetchOpts);
        const text = await res.text();
        return { status: res.status, json: text };
      } catch (err: any) {
        return {
          status: 0,
          json: JSON.stringify({ error: err.message ?? String(err) }),
        };
      }
    },
  });
}
