/**
 * Extract the primary subcommands from a bash command string.
 * Handles pipes, &&, ||, ;, subshells, and command substitution.
 * Returns an array of [command, ...args] tuples for the top-level commands.
 */
export function extractBashSubcommands(command: string): string[][] {
  // Split on command separators: &&, ||, ;, |
  const parts = command
    .split(/\s*(?:&&|\|\|?|;)\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  const result: string[][] = [];
  for (const part of parts) {
    // 1. Strip subshell wrapper
    const withoutSubshell = part.replace(/^\(|\)$/g, '').trim();

    // 2. Split into tokens
    let tokens = withoutSubshell.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // 3. Strip leading env vars BEFORE prefix skipping (FOO=bar cmd → cmd)
    while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) {
      tokens = tokens.slice(1);
    }

    // 4. Skip common wrapper prefixes that aren't real commands
    while (
      tokens.length > 0 &&
      ['sudo', 'env', 'time', 'nice', 'nohup', 'xargs'].includes(tokens[0]!)
    ) {
      tokens = tokens.slice(1);
    }

    // 5. Strip env vars AGAIN after prefix removal (handles `env FOO=bar cmd`)
    while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) {
      tokens = tokens.slice(1);
    }

    if (tokens.length === 0) continue;

    result.push(tokens);
  }
  return result;
}

/**
 * Classify a bash command's primary operations for permission heuristics.
 */
export interface BashCommandClassification {
  /** Primary commands found (e.g., ['git', 'rm', 'curl']). */
  commands: string[];
  /** True if any command is a known destructive operation. */
  hasDestructive: boolean;
  /** True if any command accesses the network. */
  hasNetwork: boolean;
  /** True if all commands are read-only. */
  isReadOnly: boolean;
  /** True if the command involves package installation. */
  hasPackageInstall: boolean;
}

const DESTRUCTIVE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'fdisk',
  'git push',
  'git reset',
  'git rebase',
  'git merge',
  'docker rm',
  'docker rmi',
  'docker system prune',
  'kubectl delete',
  'terraform destroy',
  'drop',
  'truncate',
  'delete',
]);

const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'sftp',
  'git clone',
  'git fetch',
  'git pull',
  'git push',
  'npm install',
  'npm publish',
  'yarn',
  'pnpm',
  'bun install',
  'bun add',
  'pip install',
  'pip3 install',
  'docker pull',
  'docker push',
]);

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'ls',
  'find',
  'tree',
  'du',
  'df',
  'pwd',
  'which',
  'whereis',
  'type',
  'grep',
  'rg',
  'ag',
  'ack',
  'ripgrep',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'echo',
  'printf',
  'date',
  'uname',
  'hostname',
  'whoami',
  'id',
  'env',
  'printenv',
  'set',
]);

const PACKAGE_INSTALL_COMMANDS = new Set([
  'npm install',
  'npm i',
  'npm add',
  'npm ci',
  'yarn',
  'yarn add',
  'yarn install',
  'pnpm install',
  'pnpm add',
  'bun install',
  'bun add',
  'pip install',
  'pip3 install',
  'brew install',
  'apt install',
  'apt-get install',
]);

export function classifyBashCommand(command: string): BashCommandClassification {
  const subcmds = extractBashSubcommands(command);
  const commands = subcmds.map(tokens => tokens[0] ?? '').filter(Boolean);

  // Build two-word commands for compound matching (e.g., "git push")
  const twoWordCommands = subcmds
    .filter(tokens => tokens.length >= 2)
    .map(tokens => `${tokens[0]} ${tokens[1]}`);

  const allCommandForms = [...commands, ...twoWordCommands];

  return {
    commands,
    hasDestructive: allCommandForms.some(c => DESTRUCTIVE_COMMANDS.has(c)),
    hasNetwork: allCommandForms.some(c => NETWORK_COMMANDS.has(c)),
    isReadOnly:
      commands.length > 0 &&
      subcmds.every(tokens => {
        const oneWord = tokens[0] ?? '';
        const twoWord = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : '';
        return READ_ONLY_COMMANDS.has(oneWord) || READ_ONLY_COMMANDS.has(twoWord);
      }),
    hasPackageInstall: allCommandForms.some(c => PACKAGE_INSTALL_COMMANDS.has(c)),
  };
}
