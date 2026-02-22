import type { ToolDefinition, ToolContext } from './types.js';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

export function createEnterWorktreeTool(): ToolDefinition {
  return {
    name: 'EnterWorktree',
    description:
      'Create an isolated git worktree to work on a separate branch without affecting the main working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional name for the worktree' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const name: string = input.name ?? `worktree-${randomUUID().slice(0, 8)}`;
      const worktreePath = `${ctx.cwd}/.open-agent/worktrees/${name}`;
      const branchName = `open-agent/${name}`;

      mkdirSync(`${ctx.cwd}/.open-agent/worktrees`, { recursive: true });

      const proc = Bun.spawn(
        ['git', 'worktree', 'add', '-b', branchName, worktreePath],
        {
          cwd: ctx.cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new Error(`Failed to create worktree: ${stderr}`);
      }

      return {
        worktreePath,
        worktreeBranch: branchName,
        message: `Created worktree at ${worktreePath} on branch ${branchName}`,
      };
    },
  };
}
