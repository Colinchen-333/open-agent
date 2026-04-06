/**
 * /doctor diagnostic command — checks environment health.
 * Matches Claude Code's doctor diagnostic system.
 */

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
  durationMs: number;
}

export interface DoctorReport {
  checks: DiagnosticCheck[];
  summary: { pass: number; warn: number; fail: number };
  timestamp: string;
  platform: string;
  nodeVersion: string;
  bunVersion?: string;
}

async function checkBun(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn(['bun', '--version'], { stdout: 'pipe' });
    const version = await new Response(proc.stdout).text();
    return { name: 'Bun runtime', status: 'pass', message: `v${version.trim()}`, durationMs: Math.round(performance.now() - t0) };
  } catch {
    return { name: 'Bun runtime', status: 'fail', message: 'bun not found', durationMs: Math.round(performance.now() - t0) };
  }
}

async function checkGit(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn(['git', '--version'], { stdout: 'pipe' });
    const version = await new Response(proc.stdout).text();
    return { name: 'Git', status: 'pass', message: version.trim(), durationMs: Math.round(performance.now() - t0) };
  } catch {
    return { name: 'Git', status: 'warn', message: 'git not found (some features unavailable)', durationMs: Math.round(performance.now() - t0) };
  }
}

async function checkRipgrep(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn(['rg', '--version'], { stdout: 'pipe' });
    const version = (await new Response(proc.stdout).text()).split('\n')[0]?.trim() ?? '';
    return { name: 'ripgrep', status: 'pass', message: version, durationMs: Math.round(performance.now() - t0) };
  } catch {
    return { name: 'ripgrep', status: 'warn', message: 'rg not found (Grep tool may be slower)', durationMs: Math.round(performance.now() - t0) };
  }
}

async function checkConfigDir(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const configDir = join(homedir(), '.claude');
  const exists = existsSync(configDir);
  return {
    name: 'Config directory',
    status: exists ? 'pass' : 'warn',
    message: exists ? configDir : `${configDir} (not found, will be created on first use)`,
    durationMs: Math.round(performance.now() - t0),
  };
}

async function checkDiskSpace(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn(['df', '-h', '.'], { stdout: 'pipe' });
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split('\n');
    const dataLine = lines[1]?.trim() ?? '';
    const parts = dataLine.split(/\s+/);
    const available = parts[3] ?? 'unknown';
    const usePercent = parts[4] ?? '';
    const usePct = parseInt(usePercent);
    const status = usePct > 95 ? 'fail' : usePct > 85 ? 'warn' : 'pass';
    return { name: 'Disk space', status, message: `${available} available (${usePercent} used)`, durationMs: Math.round(performance.now() - t0) };
  } catch {
    return { name: 'Disk space', status: 'warn', message: 'could not check', durationMs: Math.round(performance.now() - t0) };
  }
}

async function checkNetwork(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  try {
    const res = await fetch('https://api.anthropic.com', { signal: AbortSignal.timeout(5000) });
    return { name: 'Network (Anthropic API)', status: 'pass', message: `reachable (${res.status})`, durationMs: Math.round(performance.now() - t0) };
  } catch (err: any) {
    return { name: 'Network (Anthropic API)', status: 'warn', message: err.message?.slice(0, 80) ?? 'unreachable', durationMs: Math.round(performance.now() - t0) };
  }
}

async function checkSandbox(): Promise<DiagnosticCheck> {
  const t0 = performance.now();
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      const proc = Bun.spawn(['which', 'sandbox-exec'], { stdout: 'pipe' });
      const code = await proc.exited;
      return { name: 'Sandbox (macOS)', status: code === 0 ? 'pass' : 'warn', message: code === 0 ? 'sandbox-exec available' : 'sandbox-exec not found', durationMs: Math.round(performance.now() - t0) };
    } catch {
      return { name: 'Sandbox (macOS)', status: 'warn', message: 'check failed', durationMs: Math.round(performance.now() - t0) };
    }
  } else if (platform === 'linux') {
    try {
      const proc = Bun.spawn(['which', 'bwrap'], { stdout: 'pipe' });
      const code = await proc.exited;
      return { name: 'Sandbox (Linux)', status: code === 0 ? 'pass' : 'warn', message: code === 0 ? 'bubblewrap available' : 'bwrap not found (install bubblewrap for sandbox)', durationMs: Math.round(performance.now() - t0) };
    } catch {
      return { name: 'Sandbox (Linux)', status: 'warn', message: 'check failed', durationMs: Math.round(performance.now() - t0) };
    }
  }
  return { name: 'Sandbox', status: 'warn', message: `no sandbox support for ${platform}`, durationMs: Math.round(performance.now() - t0) };
}

/**
 * Run all diagnostic checks and produce a report.
 */
export async function runDiagnostics(): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkBun(),
    checkGit(),
    checkRipgrep(),
    checkConfigDir(),
    checkDiskSpace(),
    checkNetwork(),
    checkSandbox(),
  ]);

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    checks,
    summary,
    timestamp: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : undefined,
  };
}

/**
 * Format a doctor report for terminal display.
 */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`open-agent doctor — ${report.platform}, Bun ${report.bunVersion ?? 'N/A'}`);
  lines.push('');

  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[!!]' : '[XX]';
    lines.push(`  ${icon} ${check.name}: ${check.message} (${check.durationMs}ms)`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }

  lines.push('');
  lines.push(`Summary: ${report.summary.pass} pass, ${report.summary.warn} warnings, ${report.summary.fail} failures`);
  return lines.join('\n');
}
