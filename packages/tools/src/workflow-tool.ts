import { withToolDefaults } from './tool-defaults.js';
import { feature, loadMarkdownConfig } from '@open-agent/core';
import type { ToolDefinition, ToolContext } from './types.js';

export function createWorkflowTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Workflow',
    description:
      'Run a named workflow from ~/.claude/workflows/ or <cwd>/.claude/workflows/. ' +
      'Workflows are markdown files with step-by-step instructions the agent follows.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name (filename without .md extension)',
        },
        list: {
          type: 'boolean',
          description: 'If true, list available workflows instead of running one',
        },
        step: {
          type: 'number',
          description:
            '1-based step number to resume at. When provided, only that step is returned.',
        },
      },
    },
    capability: { category: 'workspace', risk: 'low' },
    annotations: { readOnly: true },
    shouldDefer: true,
    async execute(input: { name?: string; list?: boolean; step?: number }, ctx: ToolContext) {
      if (!feature('WORKFLOW_SCRIPTS')) {
        return {
          error: 'Workflow tool not enabled. Set OPEN_AGENT_FEATURE_WORKFLOW_SCRIPTS=1.',
        };
      }

      const entries = await loadMarkdownConfig({ subdir: 'workflows', cwd: ctx.cwd });

      if (input.list || !input.name) {
        if (entries.length === 0) {
          return {
            workflows: [],
            message:
              'No workflows found. Create .md files in ~/.claude/workflows/ or <cwd>/.claude/workflows/.',
          };
        }
        return {
          workflows: entries.map(e => ({
            name: e.name,
            description:
              typeof e.frontmatter.description === 'string' ? e.frontmatter.description : '',
            source: e.source,
          })),
        };
      }

      const workflow = entries.find(e => e.name === input.name);
      if (!workflow) {
        const available = entries.map(e => e.name).join(', ') || 'none';
        return {
          error: `Workflow "${input.name}" not found. Available: ${available}`,
        };
      }

      const description =
        typeof workflow.frontmatter.description === 'string'
          ? workflow.frontmatter.description
          : '';

      // Split body into discrete steps at numbered-list items, headings, or
      // bullet points, preserving multi-line content within each step.
      const steps = workflow.body
        .split(/\n(?=\d+\.|#{1,3}\s|[-*]\s)/)
        .map(s => s.trim())
        .filter(Boolean);

      const totalSteps = steps.length;

      // When a specific step is requested, return only that step (1-based).
      if (input.step !== undefined) {
        const idx = input.step - 1;
        if (idx < 0 || idx >= totalSteps) {
          return {
            error: `Step ${input.step} is out of range. Workflow "${workflow.name}" has ${totalSteps} step(s).`,
          };
        }
        return {
          name: workflow.name,
          description,
          step: input.step,
          totalSteps,
          content: steps[idx],
          instruction: `Execute step ${input.step} of ${totalSteps}. Report completion before proceeding.`,
        };
      }

      return {
        name: workflow.name,
        description,
        steps,
        totalSteps,
        instruction: `Follow these ${totalSteps} steps in order. Report progress after each step.`,
      };
    },
  });
}
