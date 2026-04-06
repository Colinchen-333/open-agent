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
    // Strip leading env vars (FOO=bar cmd → cmd)
    const withoutEnvVars = part.replace(/^(\w+=\S+\s+)+/, '');
    // Strip subshell wrapper
    const withoutSubshell = withoutEnvVars.replace(/^\(|\)$/g, '').trim();
    // Split into tokens
    const tokens = withoutSubshell.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // Skip common prefixes that aren't real commands
    let startIdx = 0;
    while (
      startIdx < tokens.length &&
      ['sudo', 'env', 'time', 'nice', 'nohup', 'xargs'].includes(tokens[startIdx]!)
    ) {
      startIdx++;
    }
    if (startIdx >= tokens.length) continue;

    result.push(tokens.slice(startIdx));
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
      allCommandForms.every(
        c => READ_ONLY_COMMANDS.has(c) || commands.every(cmd => READ_ONLY_COMMANDS.has(cmd)),
      ),
    hasPackageInstall: allCommandForms.some(c => PACKAGE_INSTALL_COMMANDS.has(c)),
  };
}
