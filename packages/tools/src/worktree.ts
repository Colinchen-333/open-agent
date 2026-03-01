import type { ToolDefinition, ToolContext } from './types.js';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { exec } from '@open-agent/core';

// ---------------------------------------------------------------------------
// Reusable worktree utility functions
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Create a git worktree at `<repoPath>/.open-agent/worktrees/<name>` on a new
 * branch named `open-agent/<name>`.  Returns the worktree path and branch name.
 */
export async function createWorktree(repoPath: string, name: string): Promise<WorktreeInfo> {
  const worktreePath = `${repoPath}/.open-agent/worktrees/${name}`;
  const branchName = `open-agent/${name}`;

  mkdirSync(`${repoPath}/.open-agent/worktrees`, { recursive: true });

  const { exitCode, stderr } = await exec(
    ['git', 'worktree', 'add', '-b', branchName, worktreePath],
    { cwd: repoPath, timeout: 30_000 },
  );

  if (exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  return { path: worktreePath, branch: branchName };
}

/**
 * Remove a git worktree and prune stale worktree references.
 * Runs `git worktree remove --force` followed by `git worktree prune`.
 * Errors are swallowed so cleanup never blocks the caller.
 */
export async function cleanupWorktree(worktreePath: string): Promise<void> {
  // Derive the repo root: worktrees live at <repo>/.open-agent/worktrees/<name>
  // so we can walk up or use `git -C <worktreePath> rev-parse --git-common-dir`
  // to locate the common git dir.  The simplest approach: run the remove from
  // the worktree itself using --force so even dirty trees are deleted.
  try {
    await exec(
      ['git', 'worktree', 'remove', '--force', worktreePath],
      { cwd: worktreePath, timeout: 30_000 },
    );

    // Best-effort prune regardless of exit code above.
    await exec(
      ['git', 'worktree', 'prune'],
      { cwd: worktreePath, timeout: 30_000 },
    );
  } catch {
    // Cleanup is best-effort — never throw.
  }
}

/**
 * Return true if the worktree has any tracked or untracked changes relative
 * to its HEAD commit.  Uses `git status --porcelain` for a machine-readable
 * check: any non-empty output means the tree is dirty.
 */
export async function hasWorktreeChanges(worktreePath: string): Promise<boolean> {
  try {
    const { exitCode, stdout } = await exec(
      ['git', 'status', '--porcelain'],
      { cwd: worktreePath, timeout: 30_000 },
    );

    if (exitCode !== 0) return false;
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// EnterWorktree tool (unchanged surface — now delegates to helpers above)
// ---------------------------------------------------------------------------

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
      if (ctx.abortSignal?.aborted) {
        return { error: 'Worktree creation aborted.' };
      }

      const name: string = input.name ?? `worktree-${randomUUID().slice(0, 8)}`;
      const { path: worktreePath, branch: worktreeBranch } = await createWorktree(ctx.cwd, name);

      return {
        worktreePath,
        worktreeBranch,
        message: `Created worktree at ${worktreePath} on branch ${worktreeBranch}`,
      };
    },
  };
}
