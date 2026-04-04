import { execFileSync } from 'child_process';

const MAX_STATUS_CHARS = 2000;

function runGit(cwd: string, args: string[]): string | null {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function hasGitRef(cwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', ref], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function resolveMainBranch(cwd: string, currentBranch: string): string {
  const remoteHead = runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) {
    return remoteHead.split('/').pop() ?? currentBranch;
  }
  if (hasGitRef(cwd, 'refs/heads/main')) return 'main';
  if (hasGitRef(cwd, 'refs/heads/master')) return 'master';
  return currentBranch;
}

function truncateStatus(status: string): string {
  if (status.length <= MAX_STATUS_CHARS) {
    return status;
  }
  return (
    `${status.slice(0, MAX_STATUS_CHARS)}\n` +
    '... (truncated because it exceeds 2k characters. Run `git status` with Bash for more detail.)'
  );
}

export function buildGitContextSnapshot(cwd: string): string | undefined {
  const currentBranch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!currentBranch) {
    return undefined;
  }

  const mainBranch = resolveMainBranch(cwd, currentBranch);
  const status = truncateStatus(runGit(cwd, ['--no-optional-locks', 'status', '--short']) ?? '');
  const recentCommits = runGit(cwd, ['--no-optional-locks', 'log', '--oneline', '-n', '5']);
  const gitUser = runGit(cwd, ['config', 'user.name']);

  return [
    'This is the git snapshot at the start of the session. It will not update automatically during the conversation.',
    `Current branch: ${currentBranch}`,
    `Main branch: ${mainBranch}`,
    ...(gitUser ? [`Git user: ${gitUser}`] : []),
    `Status:\n${status || '(clean)'}`,
    ...(recentCommits ? [`Recent commits:\n${recentCommits}`] : []),
  ].join('\n\n');
}
