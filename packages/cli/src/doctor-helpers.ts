import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { ConfigLoader, runtimeVersion, type Settings } from '@open-agent/core';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface DoctorMcpStatus {
  name: string;
  status: string;
}

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details?: string[];
  data?: Record<string, unknown>;
}

export interface DoctorSummary {
  total: number;
  pass: number;
  warn: number;
  fail: number;
  info: number;
  health: 'healthy' | 'degraded' | 'critical';
}

export interface DoctorReport {
  generatedAt: string;
  cwd: string;
  model: string;
  permissionMode: string;
  selectedProvider: 'anthropic' | 'openai' | 'ollama';
  checks: DoctorCheck[];
  summary: DoctorSummary;
}

export interface DoctorDiagnosticsInput {
  cwd: string;
  model: string;
  permissionMode: string;
  providerName?: 'anthropic' | 'openai' | 'ollama';
  mcpStatus?: DoctorMcpStatus[];
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface DoctorDiagnosticsDeps {
  runCommand?: (command: string, args: string[]) => CommandResult;
  pathExists?: (path: string) => boolean;
  loadSettings?: (cwd: string) => Settings;
  loadAgentInstructions?: (cwd: string) => string[];
}

interface ProviderSignals {
  anthropicKey: boolean;
  openaiKey: boolean;
  anthropicBaseUrl: string | null;
  openaiBaseUrl: string | null;
  ollamaBaseUrl: string | null;
}

const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
};

function defaultRunCommand(command: string, args: string[]): CommandResult {
  const out = spawnSync(command, args, { encoding: 'utf-8' });
  const stdout = String(out.stdout ?? '').trim();
  const stderr = String(out.stderr ?? '').trim();
  const errorMessage = out.error instanceof Error ? out.error.message : '';
  return {
    ok: out.status === 0 && !out.error,
    stdout,
    stderr: errorMessage ? [stderr, errorMessage].filter(Boolean).join('\n') : stderr,
    exitCode: out.status,
  };
}

function normalizeStatus(status: string): string {
  const value = status.trim().toLowerCase();
  return value.length === 0 ? 'unknown' : value;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : text.trim();
}

function inferSelectedProvider(env: NodeJS.ProcessEnv): 'anthropic' | 'openai' | 'ollama' {
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'ollama';
}

function getProviderSignals(env: NodeJS.ProcessEnv): ProviderSignals {
  const clean = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  return {
    anthropicKey: Boolean(clean(env.ANTHROPIC_API_KEY)),
    openaiKey: Boolean(clean(env.OPENAI_API_KEY)),
    anthropicBaseUrl: clean(env.ANTHROPIC_BASE_URL),
    openaiBaseUrl: clean(env.OPENAI_BASE_URL),
    ollamaBaseUrl: clean(env.OLLAMA_BASE_URL),
  };
}

function discoverSettingsPaths(cwd: string, pathExists: (path: string) => boolean): {
  found: string[];
  candidates: string[];
} {
  const candidates = [
    join(homedir(), '.open-agent', 'settings.json'),
    join(homedir(), '.claude', 'settings.json'),
    join(cwd, '.open-agent', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.open-agent', 'settings.local.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  const found = candidates.filter((path) => pathExists(path));
  return { found, candidates };
}

function discoverInstructionPaths(cwd: string, pathExists: (path: string) => boolean): string[] {
  const candidates: string[] = [];
  const visited = new Set<string>();
  let dir = resolve(cwd);

  while (!visited.has(dir)) {
    visited.add(dir);
    candidates.push(join(dir, 'AGENT.md'));
    candidates.push(join(dir, 'CLAUDE.md'));
    candidates.push(join(dir, '.open-agent', 'AGENT.md'));
    candidates.push(join(dir, '.claude', 'CLAUDE.md'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const userCandidates = [
    join(homedir(), '.open-agent', 'AGENT.md'),
    join(homedir(), '.claude', 'CLAUDE.md'),
  ];

  const found = [...userCandidates, ...candidates].filter((path, index, arr) => {
    if (!pathExists(path)) return false;
    return arr.indexOf(path) === index;
  });

  return found;
}

function commandCheck(
  id: string,
  title: string,
  command: string,
  args: string[],
  runCommand: (command: string, args: string[]) => CommandResult,
  unavailableHint: string,
): DoctorCheck {
  const result = runCommand(command, args);
  if (result.ok) {
    const summary = firstLine(result.stdout) || `${command} command is available.`;
    return {
      id,
      title,
      status: 'pass',
      summary,
      data: { command, args, exitCode: result.exitCode },
    };
  }

  const details = [result.stderr, unavailableHint].filter(Boolean);
  return {
    id,
    title,
    status: 'fail',
    summary: `${command} command is not available.`,
    ...(details.length > 0 ? { details } : {}),
    data: { command, args, exitCode: result.exitCode },
  };
}

function providerChecks(
  selectedProvider: 'anthropic' | 'openai' | 'ollama',
  signals: ProviderSignals,
): DoctorCheck[] {
  const details = [
    `ANTHROPIC_API_KEY: ${signals.anthropicKey ? 'set' : 'missing'}`,
    `OPENAI_API_KEY: ${signals.openaiKey ? 'set' : 'missing'}`,
    `OPENAI_BASE_URL: ${signals.openaiBaseUrl ?? '(default)'}`,
    `OLLAMA_BASE_URL: ${signals.ollamaBaseUrl ?? 'http://localhost:11434 (default)'}`,
    `ANTHROPIC_BASE_URL: ${signals.anthropicBaseUrl ?? '(default)'}`,
  ];

  const inventory: DoctorCheck = {
    id: 'provider-signals',
    title: 'Provider Environment Signals',
    status: 'info',
    summary: `Selected provider: ${selectedProvider}`,
    details,
    data: {
      selectedProvider,
      ...signals,
    },
  };

  if (selectedProvider === 'anthropic') {
    return [
      inventory,
      signals.anthropicKey
        ? {
            id: 'provider-selected-ready',
            title: 'Selected Provider Readiness',
            status: 'pass',
            summary: 'Anthropic provider looks ready (ANTHROPIC_API_KEY is set).',
          }
        : {
            id: 'provider-selected-ready',
            title: 'Selected Provider Readiness',
            status: 'fail',
            summary: 'Anthropic provider is selected but ANTHROPIC_API_KEY is missing.',
            details: ['Set ANTHROPIC_API_KEY or switch provider/model.'],
          },
    ];
  }

  if (selectedProvider === 'openai') {
    return [
      inventory,
      signals.openaiKey
        ? {
            id: 'provider-selected-ready',
            title: 'Selected Provider Readiness',
            status: 'pass',
            summary: 'OpenAI provider looks ready (OPENAI_API_KEY is set).',
          }
        : {
            id: 'provider-selected-ready',
            title: 'Selected Provider Readiness',
            status: 'fail',
            summary: 'OpenAI provider is selected but OPENAI_API_KEY is missing.',
            details: ['Set OPENAI_API_KEY or switch provider/model.'],
          },
    ];
  }

  return [
    inventory,
    {
      id: 'provider-selected-ready',
      title: 'Selected Provider Readiness',
      status: 'pass',
      summary: `Ollama provider selected (base URL: ${signals.ollamaBaseUrl ?? 'http://localhost:11434'}).`,
      details: [
        'OpenAgent will use local Ollama when no cloud API key is configured.',
      ],
    },
  ];
}

function summarizeChecks(checks: DoctorCheck[]): DoctorSummary {
  const summary: DoctorSummary = {
    total: checks.length,
    pass: 0,
    warn: 0,
    fail: 0,
    info: 0,
    health: 'healthy',
  };

  for (const check of checks) {
    summary[check.status] += 1;
  }

  if (summary.fail > 0) {
    summary.health = 'critical';
  } else if (summary.warn > 0) {
    summary.health = 'degraded';
  }

  return summary;
}

export function collectDoctorReport(
  input: DoctorDiagnosticsInput,
  deps: DoctorDiagnosticsDeps = {},
): DoctorReport {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const pathExists = deps.pathExists ?? existsSync;
  const env = input.env ?? process.env;
  const selectedProvider = input.providerName ?? inferSelectedProvider(env);
  const configLoader = new ConfigLoader();
  const settings = deps.loadSettings
    ? deps.loadSettings(input.cwd)
    : configLoader.loadSettings(input.cwd);
  const instructionList = deps.loadAgentInstructions
    ? deps.loadAgentInstructions(input.cwd)
    : configLoader.loadAgentMd(input.cwd);

  const checks: DoctorCheck[] = [];

  checks.push(
    commandCheck(
      'git',
      'Git CLI',
      'git',
      ['--version'],
      runCommand,
      'Install git to enable diff/review/commit workflows.',
    ),
  );
  checks.push(
    commandCheck(
      'ripgrep',
      'Ripgrep CLI',
      'rg',
      ['--version'],
      runCommand,
      'Install ripgrep (`rg`) for high-performance code search tools.',
    ),
  );

  const bunVersion = runCommand('bun', ['--version']);
  const nodeVersion = runCommand('node', ['--version']);
  const runtimeName = 'Bun' in globalThis ? 'bun' : 'node';
  const availableRuntimes: string[] = [];
  if (bunVersion.ok) availableRuntimes.push(`bun ${firstLine(bunVersion.stdout)}`);
  if (nodeVersion.ok) availableRuntimes.push(`node ${firstLine(nodeVersion.stdout)}`);

  checks.push({
    id: 'runtime',
    title: 'Runtime (Bun/Node)',
    status: availableRuntimes.length > 0 ? 'pass' : 'fail',
    summary:
      availableRuntimes.length > 0
        ? `Detected ${availableRuntimes.join(', ')}. Active runtime: ${runtimeName} ${runtimeVersion}.`
        : 'Neither bun nor node command is available in PATH.',
    ...(availableRuntimes.length === 0
      ? { details: ['Install Bun (recommended) or Node.js to run OpenAgent.'] }
      : {}),
    data: {
      activeRuntime: runtimeName,
      runtimeVersion,
      bun: bunVersion.ok ? firstLine(bunVersion.stdout) : null,
      node: nodeVersion.ok ? firstLine(nodeVersion.stdout) : null,
    },
  });

  const cwdResolved = resolve(input.cwd);
  checks.push({
    id: 'context',
    title: 'Session Context',
    status: 'info',
    summary: `CWD: ${cwdResolved}`,
    details: [
      `Model: ${input.model}`,
      `Permission mode: ${input.permissionMode}`,
      `Selected provider: ${selectedProvider}`,
    ],
    data: {
      cwd: cwdResolved,
      model: input.model,
      permissionMode: input.permissionMode,
      selectedProvider,
    },
  });

  checks.push(...providerChecks(selectedProvider, getProviderSignals(env)));

  const settingsPaths = discoverSettingsPaths(cwdResolved, pathExists);
  checks.push({
    id: 'settings',
    title: 'Settings Files',
    status: settingsPaths.found.length > 0 ? 'pass' : 'warn',
    summary:
      settingsPaths.found.length > 0
        ? `Found ${settingsPaths.found.length} settings file(s).`
        : 'No settings files found (.open-agent/.claude). Defaults will be used.',
    details:
      settingsPaths.found.length > 0
        ? settingsPaths.found
        : settingsPaths.candidates,
    data: {
      found: settingsPaths.found,
      candidates: settingsPaths.candidates,
    },
  });

  const instructionPaths = discoverInstructionPaths(cwdResolved, pathExists);
  checks.push({
    id: 'instructions',
    title: 'Instruction Files (AGENT.md / CLAUDE.md)',
    status: instructionPaths.length > 0 ? 'pass' : 'warn',
    summary:
      instructionPaths.length > 0
        ? `Detected ${instructionPaths.length} instruction file(s).`
        : 'No AGENT.md/CLAUDE.md instruction files detected.',
    details:
      instructionPaths.length > 0
        ? instructionPaths
        : ['Add AGENT.md or .open-agent/AGENT.md to provide project guidance.'],
    data: {
      loadedInstructionBlocks: instructionList.length,
      detectedPaths: instructionPaths,
    },
  });

  const settingsMcpServers = settings.mcpServers && typeof settings.mcpServers === 'object'
    ? Object.keys(settings.mcpServers)
    : [];
  const runtimeMcpStatuses = input.mcpStatus ?? [];
  const connectedCount = runtimeMcpStatuses.filter((item) => normalizeStatus(item.status) === 'connected').length;
  const failedCount = runtimeMcpStatuses.filter((item) => normalizeStatus(item.status) === 'failed').length;
  const mcpStatus: DoctorCheckStatus = settingsMcpServers.length > 0 || runtimeMcpStatuses.length > 0
    ? connectedCount === 0 && failedCount > 0
      ? 'warn'
      : 'pass'
    : 'warn';

  checks.push({
    id: 'mcp',
    title: 'MCP Configuration',
    status: mcpStatus,
    summary:
      settingsMcpServers.length > 0 || runtimeMcpStatuses.length > 0
        ? `Configured MCP servers: ${settingsMcpServers.length}. Runtime visible: ${runtimeMcpStatuses.length}.`
        : 'No MCP servers configured in settings.',
    details: [
      ...(settingsMcpServers.length > 0
        ? [`Configured: ${settingsMcpServers.join(', ')}`]
        : ['Configured: (none)']),
      ...(runtimeMcpStatuses.length > 0
        ? runtimeMcpStatuses.map((item) => `Runtime: ${item.name} -> ${item.status}`)
        : ['Runtime: (no status provided)']),
    ],
    data: {
      configuredServers: settingsMcpServers,
      runtimeStatuses: runtimeMcpStatuses,
      connectedCount,
      failedCount,
    },
  });

  const summary = summarizeChecks(checks);
  return {
    generatedAt: new Date().toISOString(),
    cwd: cwdResolved,
    model: input.model,
    permissionMode: input.permissionMode,
    selectedProvider,
    checks,
    summary,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('OpenAgent Doctor Report');
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`CWD: ${report.cwd}`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Permission mode: ${report.permissionMode}`);
  lines.push(`Selected provider: ${report.selectedProvider}`);
  lines.push('');
  lines.push('Checks:');

  for (const check of report.checks) {
    lines.push(`- [${STATUS_LABEL[check.status]}] ${check.title}: ${check.summary}`);
    if (check.details && check.details.length > 0) {
      for (const detail of check.details) {
        lines.push(`  ${detail}`);
      }
    }
  }

  lines.push('');
  lines.push(
    `Summary: total=${report.summary.total}, pass=${report.summary.pass}, warn=${report.summary.warn}, fail=${report.summary.fail}, info=${report.summary.info}, health=${report.summary.health}`,
  );
  return lines.join('\n');
}

export function buildDoctorOutput(
  input: DoctorDiagnosticsInput,
  deps: DoctorDiagnosticsDeps = {},
): { report: DoctorReport; text: string } {
  const report = collectDoctorReport(input, deps);
  return { report, text: formatDoctorReport(report) };
}
