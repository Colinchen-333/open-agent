import type { ToolDefinition, ToolContext } from './types.js';
import type { SkillCatalogEntry, ResolvedSkillInvocation } from '@open-agent/skills';
import { truncateSummary } from './tool-summary.js';
import { withToolDefaults } from './tool-defaults.js';

export interface SkillDeps {
  resolveSkill?: (name: string, args?: string) => Promise<ResolvedSkillInvocation | null>;
  executeSkill?: (name: string, args?: string) => Promise<string>;
  listSkills: () => SkillCatalogEntry[];
}

export function createSkillTool(deps: SkillDeps): ToolDefinition {
  return withToolDefaults({
    name: 'Skill',
    description: 'Resolve and apply a named skill workflow within the conversation.',
    getToolUseSummary(input: { skill: string }, _result, isError) {
      const label = truncateSummary(input.skill, 40);
      return isError ? `Skill failed: ${label}` : `Used skill ${label}`;
    },
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
    isReadOnly: true,
    async execute(input: any, _ctx: ToolContext) {
      const { skill, args } = input as { skill: string; args?: string };
      try {
        if (deps.resolveSkill) {
          const resolved = await deps.resolveSkill(skill, args);
          if (!resolved) {
            const available = deps.listSkills().map((entry) => entry.name).join(', ');
            return `Skill "${skill}" not found. Available skills: ${available || '(none)'}`;
          }

          const lines = [
            `<skill name="${resolved.name}" source="${resolved.source}">`,
            resolved.description ? `Description: ${resolved.description}` : 'Description: (none)',
            resolved.allowedTools?.length ? `Allowed tools: ${resolved.allowedTools.join(', ')}` : 'Allowed tools: inherit',
            resolved.disallowedTools?.length ? `Disallowed tools: ${resolved.disallowedTools.join(', ')}` : 'Disallowed tools: (none)',
            resolved.path ? `Path: ${resolved.path}` : '',
            '',
            resolved.prompt,
            '</skill>',
          ].filter(Boolean);
          return lines.join('\n');
        }

        if (!deps.executeSkill) {
          throw new Error('Skill tool is missing a resolver.');
        }
        return await deps.executeSkill(skill, args);
      } catch (err: unknown) {
        return `Error executing skill "${skill}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
