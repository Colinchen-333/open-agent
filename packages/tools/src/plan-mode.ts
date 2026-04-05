import type { ToolDefinition, ToolContext } from './types.js';

export interface PlanModeDeps {
  enterPlanMode: () => void;
  exitPlanMode: (allowedPrompts?: { tool: string; prompt: string }[]) => void;
  isPlanMode: () => boolean;
}

/** Options for engine-based plan mode tools (mode stack variant). */
export interface PlanModeEngineOpts {
  engine: {
    pushMode(mode: 'plan'): void;
    popMode(): void;
    getMode(): string;
  };
}

/**
 * createEnterPlanModeTool — factory for the EnterPlanMode built-in tool.
 *
 * Accepts two calling conventions:
 *   1. Legacy `PlanModeDeps` callbacks (used by apps/cli/src/index.ts)
 *   2. Engine-based `{ engine: PermissionEngine }` — calls `engine.pushMode('plan')`
 */
export function createEnterPlanModeTool(deps: PlanModeDeps | PlanModeEngineOpts): ToolDefinition {
  if ('engine' in deps) {
    const { engine } = deps;
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
        engine.pushMode('plan');
        return 'Entered plan mode. You can now explore the codebase and design your approach. Use ExitPlanMode when your plan is ready for user approval.';
      },
    };
  }

  // Legacy PlanModeDeps form
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

/**
 * createExitPlanModeTool — factory for the ExitPlanMode built-in tool.
 *
 * Accepts two calling conventions:
 *   1. Legacy `PlanModeDeps` callbacks (used by apps/cli/src/index.ts)
 *   2. Engine-based `{ engine: PermissionEngine }` — calls `engine.popMode()`
 */
export function createExitPlanModeTool(deps: PlanModeDeps | PlanModeEngineOpts): ToolDefinition {
  if ('engine' in deps) {
    const { engine } = deps;
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
      async execute(_input: any, _ctx: ToolContext) {
        engine.popMode();
        return `Exited plan mode. The plan has been submitted for user approval.`;
      },
    };
  }

  // Legacy PlanModeDeps form
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
