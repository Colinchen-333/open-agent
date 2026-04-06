import type { ToolDefinition, ToolContext } from './types.js';
import { withToolDefaults } from './tool-defaults.js';
import { feature } from '@open-agent/core';

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
    /** Optional — clears stale allowedPrompts from a previous plan phase. */
    clearAllowedPrompts?: () => void;
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
    return withToolDefaults({
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
        // Clear any allowedPrompts that were registered during a previous plan
        // phase so that stale permissions from an old plan do not carry over
        // into the new one.
        if (typeof engine.clearAllowedPrompts === 'function') {
          engine.clearAllowedPrompts();
        }
        return 'Entered plan mode. You can now explore the codebase and design your approach. Use ExitPlanMode when your plan is ready for user approval.';
      },
    });
  }

  // Legacy PlanModeDeps form
  return withToolDefaults({
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
  });
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
    return withToolDefaults({
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
    });
  }

  // Legacy PlanModeDeps form
  return withToolDefaults({
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
  });
}

/** Options for ExitPlanModeV2 — engine must support registerAllowedPrompts (optional for compat). */
export interface ExitPlanModeV2Opts {
  engine: {
    popMode(): void;
    getMode(): string;
    registerAllowedPrompts?: (prompts: Array<{ tool: string; prompt: string }>) => void;
  };
}

/**
 * createExitPlanModeV2Tool — factory for the ExitPlanModeV2 built-in tool.
 *
 * Feature-gated via `feature('EXIT_PLAN_MODE_V2')`. When the flag is off the
 * tool returns an error payload and does NOT pop the mode stack.
 *
 * When enabled:
 *   1. Registers `allowedPrompts` via `engine.registerAllowedPrompts` (if present).
 *   2. Pops the current mode (exits plan mode).
 *   3. Returns the new mode, the plan text, and how many prompts were registered.
 */
export function createExitPlanModeV2Tool(opts: ExitPlanModeV2Opts): ToolDefinition {
  const { engine } = opts;
  return withToolDefaults({
    name: 'ExitPlanModeV2',
    description:
      'Exit plan mode and register semantic permission requests for the live phase. Each allowedPrompt names a tool category and a natural-language description of the intent (e.g., "run tests", "install dependencies"). The classifier uses these to auto-approve matching operations without prompting.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The finalized plan body.' },
        allowedPrompts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['tool', 'prompt'],
          },
          description: 'Semantic permission requests to pre-approve for the live phase.',
        },
      },
      required: ['plan'],
    },
    async execute(input: { plan: string; allowedPrompts?: Array<{ tool: string; prompt: string }> }) {
      if (!feature('EXIT_PLAN_MODE_V2')) {
        return {
          error: 'ExitPlanModeV2 is not enabled (set OPEN_AGENT_FEATURE_EXIT_PLAN_MODE_V2=1)',
          fallback: 'Use ExitPlanMode (v1) instead.',
        };
      }
      const prompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
      if (prompts.length > 0 && engine.registerAllowedPrompts) {
        engine.registerAllowedPrompts(prompts);
      }
      engine.popMode();
      return {
        mode: engine.getMode(),
        plan: input.plan,
        allowedPromptsRegistered: prompts.length,
      };
    },
  });
}
