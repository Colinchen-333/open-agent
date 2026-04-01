export type BashCommandRiskLevel =
  | 'read-only'
  | 'workspace-write'
  | 'network'
  | 'destructive';

export interface BashCommandClassification {
  level: BashCommandRiskLevel;
  reason: string;
  categories: string[];
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string; category: string }> = [
  { pattern: /\brm\s+(-rf?|-r\s+-f|-f\s+-r|--recursive)\b/i, reason: 'recursive delete', category: 'delete' },
  { pattern: /\bgit\s+push(\s+--force|-f)\b/i, reason: 'force push', category: 'git-write' },
  { pattern: /\bgit\s+push\b/i, reason: 'git push', category: 'git-write' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'hard reset', category: 'git-write' },
  { pattern: /\bgit\s+checkout\s+\.\b/i, reason: 'discard local changes', category: 'git-write' },
  { pattern: /\bgit\s+clean\b/i, reason: 'git clean', category: 'git-write' },
  { pattern: /\bsudo\b/i, reason: 'privileged command', category: 'privileged' },
  { pattern: /\bchmod\b/i, reason: 'permission change', category: 'permission-change' },
  { pattern: /\bchown\b/i, reason: 'ownership change', category: 'permission-change' },
  { pattern: /\bmkfs\b/i, reason: 'filesystem formatting', category: 'system-write' },
  { pattern: /\bdd\s+/i, reason: 'raw disk write', category: 'system-write' },
  { pattern: /\bkill\s+-9\b/i, reason: 'force kill', category: 'process-control' },
  { pattern: /\bpkill\b/i, reason: 'kill processes by pattern', category: 'process-control' },
  { pattern: />\s*\/dev\//i, reason: 'device write redirection', category: 'system-write' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh)\b/i, reason: 'remote script execution', category: 'remote-exec' },
  { pattern: /\bwget\b.*\|\s*(bash|sh)\b/i, reason: 'remote script execution', category: 'remote-exec' },
  { pattern: /\$\(\s*(curl|wget)\b/i, reason: 'network command substitution', category: 'remote-exec' },
  { pattern: /\beval\b/i, reason: 'dynamic shell evaluation', category: 'dynamic-exec' },
];

const NETWORK_PATTERNS: Array<{ pattern: RegExp; reason: string; category: string }> = [
  { pattern: /\bcurl\b/i, reason: 'network fetch', category: 'network' },
  { pattern: /\bwget\b/i, reason: 'network fetch', category: 'network' },
  { pattern: /\bgh\s+api\b/i, reason: 'GitHub API request', category: 'network' },
  { pattern: /\bgit\s+(fetch|pull|clone)\b/i, reason: 'git network operation', category: 'network' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+install\b/i, reason: 'package install', category: 'package-install' },
  { pattern: /\bpip(3)?\s+install\b/i, reason: 'python package install', category: 'package-install' },
  { pattern: /\bgo\s+get\b/i, reason: 'go dependency install', category: 'package-install' },
  { pattern: /\bcargo\s+(add|install)\b/i, reason: 'cargo dependency install', category: 'package-install' },
];

const WORKSPACE_WRITE_PATTERNS: Array<{ pattern: RegExp; reason: string; category: string }> = [
  { pattern: /\b(mkdir|touch)\b/i, reason: 'filesystem write', category: 'workspace-write' },
  { pattern: /\b(cp|mv)\b/i, reason: 'filesystem mutation', category: 'workspace-write' },
  { pattern: /\btee\b/i, reason: 'filesystem write', category: 'workspace-write' },
  { pattern: /(?:^|[|;&\s])>{1,2}\s*(?!\/dev\/)\S/i, reason: 'output redirected to file', category: 'workspace-write' },
  { pattern: /\bgit\s+(add|apply|restore|commit|merge|cherry-pick|revert)\b/i, reason: 'git workspace mutation', category: 'git-write' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(test|run|exec)\b/i, reason: 'project script execution', category: 'script-exec' },
  { pattern: /\b(pytest|vitest|jest|cargo test|go test|bun test)\b/i, reason: 'test execution', category: 'script-exec' },
];

const READ_ONLY_PATTERNS: Array<{ pattern: RegExp; reason: string; category: string }> = [
  { pattern: /^\s*(pwd|ls|find|tree|which|whereis|env|printenv)\b/i, reason: 'shell inspection', category: 'inspect' },
  { pattern: /^\s*(cat|head|tail|less|more)\b/i, reason: 'file read', category: 'read' },
  { pattern: /^\s*(grep|rg|sed\s+-n)\b/i, reason: 'search command', category: 'search' },
  { pattern: /^\s*git\s+(status|diff|log|show|branch|rev-parse)\b/i, reason: 'git inspection', category: 'git-read' },
  { pattern: /^\s*echo\b/i, reason: 'stdout only', category: 'stdout' },
  { pattern: /^\s*(node|python|python3|ruby|go|cargo|bun|npm)\s+(-v|--version|version)\b/i, reason: 'version check', category: 'inspect' },
];

export function classifyBashCommand(command: string): BashCommandClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      level: 'read-only',
      reason: 'empty command',
      categories: ['inspect'],
    };
  }

  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return {
        level: 'destructive',
        reason: entry.reason,
        categories: [entry.category],
      };
    }
  }

  for (const entry of NETWORK_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return {
        level: 'network',
        reason: entry.reason,
        categories: [entry.category],
      };
    }
  }

  for (const entry of WORKSPACE_WRITE_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return {
        level: 'workspace-write',
        reason: entry.reason,
        categories: [entry.category],
      };
    }
  }

  for (const entry of READ_ONLY_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return {
        level: 'read-only',
        reason: entry.reason,
        categories: [entry.category],
      };
    }
  }

  return {
    level: 'workspace-write',
    reason: 'unclassified shell command',
    categories: ['unknown'],
  };
}
