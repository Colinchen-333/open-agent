export type BashRiskLevel =
  | 'read-only'
  | 'workspace-write'
  | 'network'
  | 'network-pipe'
  | 'system'
  | 'destructive'
  | 'unknown';

export interface BashRiskClassification {
  level: BashRiskLevel;
  reason: string;
  categories: string[];
}

type PatternWithReason = readonly [RegExp, string, string];

const DESTRUCTIVE_PATTERNS: PatternWithReason[] = [
  [/\brm\s+(-rf?|-r\s+-f|-f\s+-r|--recursive)\b/i, 'recursive deletion', 'delete'],
  [/\bgit\s+push(\s+--force|-f)\b/i, 'force push', 'git-write'],
  [/\bgit\s+push\b/i, 'git push', 'git-write'],
  [/\bgit\s+reset\s+--hard\b/i, 'hard reset', 'git-write'],
  [/\bgit\s+checkout\s+\.\b/i, 'discarding tracked changes', 'git-write'],
  [/\bgit\s+clean\b/i, 'git clean', 'git-write'],
  [/\bmkfs\b/i, 'filesystem formatting', 'system-write'],
  [/\bdd\s+/i, 'raw block device write', 'system-write'],
  [/\bkill\s+-9\b/i, 'force kill', 'process-control'],
  [/\bpkill\b/i, 'process kill pattern', 'process-control'],
  [/(?:^|[|;&\s])>{1,2}\s*\/dev\//i, 'device redirection', 'system-write'],
  [/\b(shutdown|reboot|poweroff|halt)\b/i, 'host shutdown/reboot', 'system-write'],
];

const SYSTEM_PATTERNS: PatternWithReason[] = [
  [/\bsudo\b/i, 'privilege escalation', 'privileged'],
  [/\b(chmod|chown|chgrp)\b/i, 'permission or ownership change', 'permission-change'],
  [/\b(systemctl|service|launchctl)\b/i, 'service management', 'system-write'],
  [/\b(useradd|usermod|userdel|groupadd|groupdel|passwd)\b/i, 'user management', 'system-write'],
  [/\b(mount|umount)\b/i, 'filesystem mount operation', 'system-write'],
];

const NETWORK_PIPE_PATTERNS: PatternWithReason[] = [
  [/\bcurl\b[^|]*\|\s*(bash|sh|zsh)\b/i, 'remote script piped into shell', 'remote-exec'],
  [/\bwget\b[^|]*\|\s*(bash|sh|zsh)\b/i, 'remote script piped into shell', 'remote-exec'],
  [/\$\(\s*(curl|wget)\b/i, 'command substitution from network content', 'remote-exec'],
  [/\b(bash|sh|zsh)\s+<\(\s*(curl|wget)\b/i, 'process substitution from network content', 'remote-exec'],
];

const NETWORK_PATTERNS: PatternWithReason[] = [
  [/\b(curl|wget|httpie)\b/i, 'network fetch', 'network'],
  [/\b(ssh|scp|sftp|rsync)\b/i, 'remote shell or transfer', 'network'],
  [/\b(nc|netcat|telnet)\b/i, 'raw network client', 'network'],
  [/\bgit\s+(clone|fetch|pull)\b/i, 'git network operation', 'network'],
  [/\b(npm|pnpm|yarn|bun)\s+(install|add)\b/i, 'package installation', 'package-install'],
  [/\bpip(?:3)?\s+install\b/i, 'python package installation', 'package-install'],
  [/\bcargo\s+install\b/i, 'rust package installation', 'package-install'],
  [/\bdocker\s+(pull|push|login)\b/i, 'container registry operation', 'network'],
];

const READ_ONLY_PATTERNS: PatternWithReason[] = [
  [/^\s*(pwd|ls|ll|la|tree|which|whereis|whoami|env|printenv|date|uname|id)\b/i, 'shell inspection', 'inspect'],
  [/^\s*(cat|head|tail|less|more|wc|cut|sort|uniq|stat)\b/i, 'read-only file inspection', 'read'],
  [/^\s*(rg|grep|find|fd)\b/i, 'search', 'search'],
  [/^\s*git\s+(status|diff|log|show|branch|rev-parse)\b/i, 'git inspection', 'git-read'],
  [/^\s*echo\b[^|;&<>]*$/i, 'stdout only', 'stdout'],
  [/^\s*(node|python|python3|ruby|go|cargo|bun|npm)\s+(-v|--version|version)\b/i, 'version check', 'inspect'],
];

const WORKSPACE_WRITE_PATTERNS: PatternWithReason[] = [
  [/\b(touch|mkdir|mv|cp)\b/i, 'filesystem mutation', 'workspace-write'],
  [/\bsed\s+-i\b/i, 'in-place file edit', 'workspace-write'],
  [/\btee\b/i, 'file write via tee', 'workspace-write'],
  [/(?:^|[|;&\s])>{1,2}\s*(?!\/(?:dev|etc|usr|bin|sbin|var|proc|sys|boot|System|Library)\b)\S+/i, 'file redirection', 'workspace-write'],
  [/\bgit\s+(commit|merge|rebase|cherry-pick|apply|stash)\b/i, 'git mutation', 'git-write'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|format)\b/i, 'project command with side effects', 'script-exec'],
  [/\b(make|cmake|gradle|mvn|cargo|go|pytest|vitest|jest)\b/i, 'build or test command', 'script-exec'],
];

const SYSTEM_PATH_WRITE_HINT = /(?:^|[\s"'`])\/(?:etc|usr|bin|sbin|var|proc|sys|dev|boot|System|Library)\b/i;
const WRITE_VERB_HINT = /\b(rm|touch|mkdir|mv|cp|chmod|chown|chgrp|sed|tee)\b|(?:^|[|;&\s])>{1,2}\s*\S+/i;

function findMatch(command: string, patterns: readonly PatternWithReason[]): BashRiskClassification | null {
  for (const [pattern, reason, category] of patterns) {
    if (pattern.test(command)) {
      return { level: 'unknown', reason, categories: [category] };
    }
  }
  return null;
}

export function classifyBashCommand(command: string): BashRiskClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: 'read-only', reason: 'empty command', categories: ['inspect'] };
  }

  const segments = trimmed
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const destructive = findMatch(segment, DESTRUCTIVE_PATTERNS);
    if (destructive) {
      return { level: 'destructive', reason: destructive.reason, categories: destructive.categories };
    }

    const system = findMatch(segment, SYSTEM_PATTERNS);
    if (system) {
      return { level: 'system', reason: system.reason, categories: system.categories };
    }

    if (SYSTEM_PATH_WRITE_HINT.test(segment) && WRITE_VERB_HINT.test(segment)) {
      return { level: 'system', reason: 'write-like operation targets a system path', categories: ['system-write'] };
    }

    const networkPipe = findMatch(segment, NETWORK_PIPE_PATTERNS);
    if (networkPipe) {
      return { level: 'network-pipe', reason: networkPipe.reason, categories: networkPipe.categories };
    }

    const network = findMatch(segment, NETWORK_PATTERNS);
    if (network) {
      return { level: 'network', reason: network.reason, categories: network.categories };
    }
  }

  if (segments.length > 1 && segments.every((segment) => findMatch(segment, READ_ONLY_PATTERNS))) {
    return { level: 'read-only', reason: 'read-only command chain', categories: ['inspection', 'chain'] };
  }

  if (
    segments.length > 1 &&
    segments.every((segment) =>
      findMatch(segment, READ_ONLY_PATTERNS)
      || findMatch(segment, WORKSPACE_WRITE_PATTERNS)
    )
  ) {
    return { level: 'workspace-write', reason: 'workspace mutation command chain', categories: ['workspace-write', 'chain'] };
  }

  const readOnly = findMatch(trimmed, READ_ONLY_PATTERNS);
  if (readOnly) {
    return { level: 'read-only', reason: readOnly.reason, categories: readOnly.categories };
  }

  const workspaceWrite = findMatch(trimmed, WORKSPACE_WRITE_PATTERNS);
  if (workspaceWrite) {
    return { level: 'workspace-write', reason: workspaceWrite.reason, categories: workspaceWrite.categories };
  }

  return { level: 'unknown', reason: 'unclassified shell command', categories: ['unknown'] };
}
