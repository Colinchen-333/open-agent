/**
 * SSH gateway for remote agent execution.
 * Stub matching Claude Code's `claude ssh <host> [dir]` command.
 *
 * Full implementation would SSH into the host and spawn open-agent there.
 * This provides the command parsing and connection setup skeleton.
 */

export interface SshGatewayConfig {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  remoteDir?: string;
  permissionMode?: string;
}

export interface SshGatewayResult {
  connected: boolean;
  error?: string;
  remoteSessionId?: string;
}

/**
 * Parse SSH connection string: [user@]host[:port] [dir]
 */
export function parseSshTarget(target: string): { user?: string; host: string; port?: number } {
  let user: string | undefined;
  let host: string;
  let port: number | undefined;

  // Extract user@
  if (target.includes('@')) {
    const parts = target.split('@');
    user = parts[0];
    target = parts[1]!;
  }

  // Extract :port
  if (target.includes(':')) {
    const parts = target.split(':');
    host = parts[0]!;
    const portStr = parts[1];
    if (portStr && /^\d+$/.test(portStr)) {
      port = parseInt(portStr, 10);
    } else {
      host = target; // colon was part of IPv6 or similar
    }
  } else {
    host = target;
  }

  return { user, host, port };
}

/**
 * Build SSH command arguments for spawning open-agent remotely.
 */
export function buildSshCommand(config: SshGatewayConfig): string[] {
  const args: string[] = ['ssh'];

  if (config.port) args.push('-p', String(config.port));
  if (config.identityFile) args.push('-i', config.identityFile);

  // Build target
  const target = config.user ? `${config.user}@${config.host}` : config.host;
  args.push(target);

  // Remote command: cd to dir and exec open-agent
  const remoteCmd = config.remoteDir
    ? `cd ${config.remoteDir} && open-agent --permission-mode ${config.permissionMode ?? 'default'}`
    : `open-agent --permission-mode ${config.permissionMode ?? 'default'}`;

  args.push(remoteCmd);

  return args;
}

/**
 * Validate SSH connectivity (dry-run check).
 */
export async function checkSshConnectivity(host: string, port?: number): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  const t0 = performance.now();
  try {
    const args = ['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes'];
    if (port) args.push('-p', String(port));
    args.push(host, 'echo ok');

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    const latencyMs = Math.round(performance.now() - t0);

    return { reachable: code === 0, latencyMs, error: code !== 0 ? `exit code ${code}` : undefined };
  } catch (err: any) {
    return { reachable: false, latencyMs: Math.round(performance.now() - t0), error: err.message };
  }
}
