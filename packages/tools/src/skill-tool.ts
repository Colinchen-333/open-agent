import type { ToolDefinition, ToolContext } from './types.js';

export interface SkillDeps {
  executeSkill: (name: string, args?: string) => Promise<string>;
  listSkills: () => { name: string; description: string }[];
}

export function createSkillTool(deps: SkillDeps): ToolDefinition {
  return {
    name: 'Skill',
    description: 'Execute a skill (slash command) within the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name (e.g., "commit", "review-pr")',
        },
        args: {
          type: 'string',
          description: 'Optional arguments for the skill',
        },
      },
      required: ['skill'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const { skill, args } = input as { skill: string; args?: string };
      try {
        return await deps.executeSkill(skill, args);
      } catch (err: unknown) {
        return `Error executing skill "${skill}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
