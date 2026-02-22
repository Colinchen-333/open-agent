import type { ToolDefinition, ToolContext } from './types.js';

export interface PlanModeDeps {
  enterPlanMode: () => void;
  exitPlanMode: (allowedPrompts?: { tool: string; prompt: string }[]) => void;
  isPlanMode: () => boolean;
}

export function createEnterPlanModeTool(deps: PlanModeDeps): ToolDefinition {
  return {
    name: 'EnterPlanMode',
    description:
      'Enter plan mode to design an implementation approach before writing code. In plan mode, you can explore the codebase but cannot edit files.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute(_input: any, _ctx: ToolContext) {
      if (deps.isPlanMode()) {
        return 'Already in plan mode.';
      }
      deps.enterPlanMode();
      return 'Entered plan mode. You can now explore the codebase and design your approach. Use ExitPlanMode when your plan is ready for user approval.';
    },
  };
}

export function createExitPlanModeTool(deps: PlanModeDeps): ToolDefinition {
  return {
    name: 'ExitPlanMode',
    description:
      'Exit plan mode after finishing your plan. The user will review and approve your plan before implementation begins.',
    inputSchema: {
      type: 'object',
      properties: {
        allowedPrompts: {
          type: 'array',
          description: 'Prompt-based permissions needed to implement the plan',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['Bash'] },
              prompt: {
                type: 'string',
                description: 'Semantic description of the action',
              },
            },
            required: ['tool', 'prompt'],
          },
        },
      },
      additionalProperties: true,
    },
    async execute(input: any, _ctx: ToolContext) {
      if (!deps.isPlanMode()) {
        return 'Not currently in plan mode.';
      }
      deps.exitPlanMode(input.allowedPrompts);
      return 'Exited plan mode. The plan has been submitted for user approval.';
    },
  };
}
