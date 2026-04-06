import { randomUUID } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, sep } from 'path';
import type { ToolDefinition, ToolContext, BashInput } from './types.js';
import { withToolDefaults } from './tool-defaults.js';
import { getOrCreateBashPty } from './bash-pty.js';
import { getBackgroundTasks } from './task-management.js';
import {
  getBackgroundTask,
  registerBackgroundTask,
  updateBackgroundTask,
} from './background-registry.js';
import { spawnProcess, feature } from '@open-agent/core';
import { summarizeCommand } from './tool-summary.js';
import { classifyBashCommand } from './bash-subcommands.js';
import {
  isDarwinSandboxAvailable,
  wrapWithDarwinSandbox,
  type DarwinSandboxRunResult,
} from './sandbox/darwin-runner.js';
import { getBackgroundTaskOutputFile } from './background-task-store.js';
import type {
  BashSandboxExecutionFinding,
  BashSandboxExecutionPolicy,
  BashSandboxExecutionProvenance,
  BashSandboxExecutionRecord,
  SandboxMetaPolicy,
} from '@open-agent/permissions';
import { filterIgnoredFindings } from '@open-agent/permissions';

const MAX_OUTPUT_LENGTH = 30000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BACKGROUND_TASKS = 100;
const BACKGROUND_TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Keep in sync with @open-agent/permissions/sandbox-adapter.ts
const BASH_SANDBOX_POLICY_FIELD = '__openAgentBashSandboxPolicy';

// Persistent CWD state across consecutive Bash calls, keyed by sessionId
// to prevent multi-session conflicts.
const persistentCwdBySession = new Map<string, string>();

interface BashSandboxPreflightFinding extends BashSandboxExecutionFinding {
  phase: 'preflight';
  feature: 'bypass' | 'network' | 'writePaths' | 'readPaths';
  executionEngine: BashSandboxExecutionPolicy['executionEngine'];
  boundaryKind: BashSandboxExecutionPolicy['boundaryKind'];
}

type BashSandboxError = Error & {
  sandboxViolation?: BashSandboxPreflightFinding;
  sandboxExecution?: BashSandboxExecutionRecord;
};

const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Prune completed background tasks older than TTL or exceeding max count. */
function pruneBackgroundTasks(tasks: Map<string, { status: string; startTime: number }>): void {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, task] of tasks) {
    if (task.status !== 'running' && now - task.startTime > BACKGROUND_TASK_TTL_MS) {
      expired.push(id);
    }
  }
  for (const id of expired) tasks.delete(id);

  // If still over limit, remove oldest completed tasks
  if (tasks.size > MAX_BACKGROUND_TASKS) {
    const completed = [...tasks.entries()]
      .filter(([, t]) => t.status !== 'running')
      .sort((a, b) => a[1].startTime - b[1].startTime);
    const toRemove = tasks.size - MAX_BACKGROUND_TASKS;
    for (let i = 0; i < Math.min(toRemove, completed.length); i++) {
      tasks.delete(completed[i][0]);
    }
  }
}

export interface BashToolDeps {
  /**
   * If set, runtime sandbox violations matching any rule in
   * `metaPolicy.ignoreViolations` are filtered out before being attached to
   * the execution record. Non-silent ignored violations are logged via
   * console.warn.
   */
  sandboxMetaPolicy?: SandboxMetaPolicy;
}

/**
 * Apply the sandbox meta policy filter to a raw findings list. Any finding
 * that matches an `ignoreViolations` rule is removed from the returned array.
 * Rules with `silent: false` trigger a console.warn for observability.
 *
 * Exported for direct unit-testing.
 */
export function applyMetaPolicyToFindings(
  rawFindings: BashSandboxExecutionFinding[],
  metaPolicy: SandboxMetaPolicy | undefined,
): BashSandboxExecutionFinding[] {
  if (!metaPolicy) return rawFindings;
  return filterIgnoredFindings(rawFindings, metaPolicy, (finding, rule) => {
    console.warn(
      `[bash] sandbox violation ignored by rule "${rule.reason}": ${(finding as any).scope ?? 'unknown'}/${finding.code} target=${(finding as any).target ?? 'n/a'}`,
    );
  });
}

export function createBashTool(deps: BashToolDeps = {}): ToolDefinition {
  return withToolDefaults({
    name: 'Bash',
    isConcurrencySafe: false,
    annotations: { destructive: true, openWorld: true },
    description:
      'Execute a bash command in the current working directory. Stdout is captured and returned. Output exceeding 30 000 characters is truncated. Working directory persists between commands; shell state (everything else) does not.',
    getToolUseSummary(input: BashInput, _result, isError) {
      const summary = summarizeCommand(input.command, input.description);
      return isError ? `Command failed: ${summary}` : `Ran ${summary}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (max 600 000). Defaults to 120 000.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what the command does',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the command in the background (fire-and-forget)',
        },
        dangerouslyDisableSandbox: {
          type: 'boolean',
          description: 'Bypass sandbox restrictions for this command (requires explicit user approval)',
        },
        sandbox: {
          type: 'boolean',
          description:
            'Run this command inside a macOS Darwin sandbox (sandbox-exec). ' +
            'Only effective on macOS when the DARWIN_SANDBOX feature flag is enabled. ' +
            'Restricts filesystem writes to the working directory and /tmp; ' +
            'does not restrict network by default.',
        },
      },
      required: ['command'],
    },

    async execute(
      input: BashInput & { dangerouslyDisableSandbox?: boolean; sandbox?: boolean; [key: string]: unknown },
      ctx: ToolContext,
    ): Promise<string> {
      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Determine effective working directory (persistent across calls, per session)
      const effectiveCwd = persistentCwdBySession.get(ctx.sessionId) ?? ctx.cwd;
      const sandboxPolicy = readSandboxPolicy(input);
      const preflightViolation = validateBashPreflight(input.command, effectiveCwd, sandboxPolicy);
      if (preflightViolation) {
        const preflightRecord = buildSandboxExecutionRecord({
          ctx,
          command: input.command,
          cwd: effectiveCwd,
          runInBackground: input.run_in_background === true,
          policy: sandboxPolicy,
          outcome: 'blocked',
          findings: applyMetaPolicyToFindings(
            collectSandboxFindings(sandboxPolicy, preflightViolation),
            deps.sandboxMetaPolicy,
          ),
        });
        appendSandboxExecutionDiagnostic(ctx, preflightRecord);
        const error: BashSandboxError = new Error(preflightViolation.message);
        error.sandboxViolation = preflightViolation;
        error.sandboxExecution = preflightRecord;
        throw error;
      }
      const sandboxEnv = buildSandboxEnv(sandboxPolicy);

      // Determine whether to apply the Darwin sandbox runner for this call.
      // Evaluated early so the PTY path can skip itself when Darwin sandbox is requested.
      // Background tasks are excluded — their fire-and-forget lifecycle makes async
      // profile cleanup unreliable, and the existing policy-based sandbox covers that path.
      const wantDarwinRunner =
        input.sandbox === true &&
        !input.run_in_background &&
        feature('DARWIN_SANDBOX') &&
        isDarwinSandboxAvailable();

      // -------------------------------------------------------------------
      // Persistent PTY path: for ordinary foreground commands that have no
      // sandbox policy and are not run in the background, use a persistent
      // node-pty shell so that cwd, env variables, shell functions, and
      // aliases survive across consecutive Bash tool calls within the same
      // agent session.
      // Darwin sandbox wrapping is incompatible with the long-lived PTY
      // shell (the PTY is persistent; sandbox-exec only wraps a single
      // process invocation), so wantDarwinRunner forces the spawn path.
      // -------------------------------------------------------------------
      const usePersistentPty =
        input.run_in_background !== true &&
        !sandboxPolicy?.enforce &&
        !wantDarwinRunner &&
        ctx.sessionId;

      if (usePersistentPty) {
        const ptySession = getOrCreateBashPty(ctx.sessionId, { cwd: effectiveCwd });

        const sandboxExecutionStartedPty = buildSandboxExecutionRecord({
          ctx,
          command: input.command,
          cwd: effectiveCwd,
          runInBackground: false,
          policy: sandboxPolicy,
          outcome: 'started',
          wrappedWithSandboxExec: false,
          findings: applyMetaPolicyToFindings(
            collectSandboxFindings(sandboxPolicy),
            deps.sandboxMetaPolicy,
          ),
        });
        appendSandboxExecutionDiagnostic(ctx, sandboxExecutionStartedPty);

        let ptyResult: { stdout: string; exitCode: number | null };
        let ptyOutcome: 'success' | 'failed' | 'timed_out';
        let ptyKilled = false;

        try {
          ptyResult = await ptySession.exec(input.command, { timeout });
          ptyOutcome = ptyResult.exitCode === 0 ? 'success' : 'failed';
        } catch (err: unknown) {
          const isTimeout = err instanceof Error && /timeout/i.test(err.message);
          if (isTimeout) {
            ptyKilled = true;
            ptyResult = { stdout: '', exitCode: null };
            ptyOutcome = 'timed_out';
          } else {
            throw err;
          }
        }

        const ptyOutput = ptyResult.stdout ? truncate(ptyResult.stdout) : '(no output)';
        const ptyExitInfo = (ptyResult.exitCode !== null && ptyResult.exitCode !== 0)
          ? `\n(exit code: ${ptyResult.exitCode})` : '';
        const ptyInterrupted = ptyKilled ? '\n(command timed out and was killed)' : '';

        const sandboxExecutionDonePty = buildSandboxExecutionRecord({
          ctx,
          command: input.command,
          cwd: effectiveCwd,
          runInBackground: false,
          policy: sandboxPolicy,
          outcome: ptyOutcome,
          wrappedWithSandboxExec: false,
          exitCode: ptyResult.exitCode,
          outputLength: ptyOutput.length,
          findings: applyMetaPolicyToFindings(
            collectSandboxFindings(sandboxPolicy),
            deps.sandboxMetaPolicy,
          ),
        });
        appendSandboxExecutionDiagnostic(ctx, sandboxExecutionDonePty);

        return ptyOutput + ptyExitInfo + ptyInterrupted;
      }

      // Use a UUID-based sentinel to avoid collisions with command output
      const CWD_SENTINEL = `___CWD_${randomUUID()}___`;
      const wrappedCommand = `cd "${effectiveCwd}" && ${input.command} ; echo "${CWD_SENTINEL}" ; pwd`;
      const sandboxedCommand = wrapWithSandboxExec(
        ['bash', '-lc', wrappedCommand],
        sandboxPolicy,
      );

      const sandboxExecutionStarted = buildSandboxExecutionRecord({
        ctx,
        command: input.command,
        cwd: effectiveCwd,
        runInBackground: input.run_in_background === true,
        policy: sandboxPolicy,
        outcome: 'started',
        wrappedWithSandboxExec: sandboxedCommand.command === DARWIN_SANDBOX_EXEC || wantDarwinRunner,
        findings: applyMetaPolicyToFindings(
          collectSandboxFindings(sandboxPolicy),
          deps.sandboxMetaPolicy,
        ),
      });
      appendSandboxExecutionDiagnostic(ctx, sandboxExecutionStarted);

      // Handle background execution
      if (input.run_in_background) {
        const taskId = `bg_${randomUUID().slice(0, 12)}`;
        const backgroundTasks = getBackgroundTasks();
        const commandSummary = summarizeCommand(input.command, input.description);
        const outputFile = getBackgroundTaskOutputFile(taskId);

        // Auto-prune old completed tasks to prevent memory leaks
        pruneBackgroundTasks(backgroundTasks);

        const outputFd = openSync(outputFile, 'a');
        const child = spawn(sandboxedCommand.command, sandboxedCommand.args, {
          cwd: effectiveCwd,
          env: { ...process.env, TERM: 'dumb', ...sandboxEnv },
          detached: true,
          stdio: ['ignore', outputFd, outputFd],
        });
        closeSync(outputFd);
        child.unref();

        registerBackgroundTask({
          task_id: taskId,
          command: input.command,
          summary: commandSummary,
          session_id: ctx.sessionId,
          cwd: effectiveCwd,
          process: child,
          output: '',
          status: 'running',
          start_time: Date.now(),
          output_file: outputFile,
          pid: child.pid,
        });

        // Async collection of output
        child.on('exit', (code) => {
          const rawOutput = safeReadBackgroundOutput(outputFile);
          const { cleanOutput, finalCwd } = extractCwd(rawOutput, CWD_SENTINEL);
          if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);
          const backgroundRecord = buildSandboxExecutionRecord({
            ctx,
            command: input.command,
            cwd: effectiveCwd,
            runInBackground: true,
            policy: sandboxPolicy,
            outcome: code === 0 ? 'success' : 'failed',
            wrappedWithSandboxExec: sandboxedCommand.command === DARWIN_SANDBOX_EXEC,
            exitCode: code,
            finalCwd,
            outputLength: cleanOutput.length,
            backgroundTaskId: taskId,
            findings: applyMetaPolicyToFindings(
              collectSandboxFindings(
                sandboxPolicy,
                code === 0 ? null : detectSandboxRuntimeViolation(rawOutput, sandboxPolicy, code),
              ),
              deps.sandboxMetaPolicy,
            ),
          });
          appendSandboxExecutionDiagnostic(ctx, backgroundRecord);
          updateBackgroundTask(taskId, {
            output: truncate(cleanOutput),
            status: code === 0 ? 'completed' : 'error',
            summary: `${code === 0 ? 'Completed' : 'Errored'}: ${commandSummary}`,
            completed_time: Date.now(),
          });
        });

        return `Background task started (id: ${taskId})`;
      }

      // Foreground execution
      // If the Darwin runner is requested, build a file-based sandbox-exec argv.
      // The result holds a temp .sb profile that must be cleaned up after the process exits.
      let darwinRunResult: DarwinSandboxRunResult | null = null;
      if (wantDarwinRunner) {
        darwinRunResult = await wrapWithDarwinSandbox(
          [sandboxedCommand.command, ...sandboxedCommand.args],
          {
            writablePaths: [effectiveCwd, '/tmp', ...(sandboxPolicy?.allowWritePaths ?? [])],
            deniedReadPaths: sandboxPolicy?.denyReadPaths ?? [],
            blockNetwork: sandboxPolicy?.networkDisabled ?? false,
            allowUnixSockets: true,
          },
        );
      }

      const spawnArgv = darwinRunResult
        ? darwinRunResult.argv
        : [sandboxedCommand.command, ...sandboxedCommand.args];

      const proc = await spawnProcess(spawnArgv, {
        cwd: effectiveCwd,
        env: { TERM: 'dumb', ...sandboxEnv },
      });

      let killed = false;
      let aborted = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeout);

      // Listen for abort signal (Ctrl+C) to kill the process promptly
      const onAbort = () => {
        aborted = true;
        proc.kill();
      };
      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const wrappedWithSandboxExec =
        sandboxedCommand.command === DARWIN_SANDBOX_EXEC || darwinRunResult !== null;

      let rawStdout: string;
      let rawStderr: string;
      try {
        [rawStdout, rawStderr] = await Promise.all([
          proc.stdoutText(),
          proc.stderrText(),
        ]);
      } finally {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
        await darwinRunResult?.cleanup();
      }

      const exitCode = await proc.exited;

      if (aborted) {
        const abortedRecord = buildSandboxExecutionRecord({
          ctx,
          command: input.command,
          cwd: effectiveCwd,
          runInBackground: false,
          policy: sandboxPolicy,
          outcome: 'aborted',
          wrappedWithSandboxExec,
          exitCode,
          findings: applyMetaPolicyToFindings(
            collectSandboxFindings(
              sandboxPolicy,
              detectSandboxRuntimeViolation(rawStderr, sandboxPolicy, exitCode),
            ),
            deps.sandboxMetaPolicy,
          ),
        });
        appendSandboxExecutionDiagnostic(ctx, abortedRecord);
        const error = new DOMException('Bash command aborted', 'AbortError') as BashSandboxError;
        error.sandboxExecution = abortedRecord;
        throw error;
      }

      // Extract final CWD from stdout and update persistent state
      const { cleanOutput: stdout, finalCwd } = extractCwd(rawStdout, CWD_SENTINEL);
      if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);

      // Truncate long output with informative message
      const truncatedStdout = truncate(stdout);
      const truncatedStderr = truncate(rawStderr);

      // Assemble output: prefer stdout; always include non-empty stderr.
      let output = truncatedStdout || '';
      if (rawStderr.trim()) {
        if (output) output += '\nSTDERR:\n' + truncatedStderr;
        else output = truncatedStderr; // Only stderr — use it directly
      }
      if (!output) output = '(no output)';

      // Exit info: only show numeric exit code if we have one.
      const exitInfo = (exitCode !== null && exitCode !== 0)
        ? `\n(exit code: ${exitCode})` : '';
      const interruptedNote = killed ? '\n(command timed out and was killed)' : '';
      const finalOutcome = killed
        ? 'timed_out'
        : exitCode === 0
          ? 'success'
          : 'failed';
      const sandboxExecution = buildSandboxExecutionRecord({
        ctx,
        command: input.command,
        cwd: effectiveCwd,
        runInBackground: false,
        policy: sandboxPolicy,
        outcome: finalOutcome,
        wrappedWithSandboxExec,
        exitCode,
        finalCwd,
        outputLength: output.length,
        findings: applyMetaPolicyToFindings(
          collectSandboxFindings(
            sandboxPolicy,
            finalOutcome === 'success'
              ? null
              : detectSandboxRuntimeViolation(rawStderr, sandboxPolicy, exitCode),
          ),
          deps.sandboxMetaPolicy,
        ),
      });
      appendSandboxExecutionDiagnostic(ctx, sandboxExecution);
      return output + exitInfo + interruptedNote;
    },
    isSearchOrReadCommand: (input: unknown): { isSearch: boolean; isRead: boolean; isList: boolean } => {
      const cmd = String((input as { command?: string }).command ?? '');
      const classification = classifyBashCommand(cmd);
      return {
        isSearch: classification.commands.some(c =>
          ['grep', 'rg', 'ag', 'ack', 'find'].includes(c),
        ),
        isRead: classification.isReadOnly,
        isList: classification.commands.some(c =>
          ['ls', 'find', 'tree'].includes(c) ||
          // Handle "git ls-files" as a two-word compound
          classification.commands.includes('git') &&
            cmd.includes('ls-files'),
        ),
      };
    },
  });
}

function safeReadBackgroundOutput(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract the final CWD from stdout that contains the sentinel line.
 * Returns the cleaned output (sentinel + pwd line removed) and the parsed CWD.
 */
function extractCwd(
  stdout: string,
  sentinel: string
): { cleanOutput: string; finalCwd: string | null } {
  const sentinelIdx = stdout.lastIndexOf(sentinel);
  if (sentinelIdx === -1) {
    return { cleanOutput: stdout, finalCwd: null };
  }

  // Everything before the sentinel is the real output
  const cleanOutput = stdout.slice(0, sentinelIdx).replace(/\n$/, '');

  // The line after the sentinel is the pwd result
  const afterSentinel = stdout.slice(sentinelIdx + sentinel.length).trim();
  const pwdLine = afterSentinel.split('\n')[0]?.trim() ?? null;
  const finalCwd = pwdLine && pwdLine.length > 0 ? pwdLine : null;

  return { cleanOutput, finalCwd };
}

function truncate(s: string): string {
  if (s.length > MAX_OUTPUT_LENGTH) {
    return (
      s.slice(0, MAX_OUTPUT_LENGTH) +
      '\n\n[Output truncated. Use head/tail/grep for large outputs.]'
    );
  }
  return s;
}

function readSandboxPolicy(
  input: BashInput & { [key: string]: unknown },
): BashSandboxExecutionPolicy | undefined {
  const raw = input[BASH_SANDBOX_POLICY_FIELD];
  if (!raw || typeof raw !== 'object') return undefined;
  const policy = raw as Partial<BashSandboxExecutionPolicy>;
  if (typeof policy.enforce !== 'boolean') return undefined;
  return {
    enforce: policy.enforce,
    executionEngine: policy.executionEngine === 'darwin-sandbox-exec' ? 'darwin-sandbox-exec' : 'none',
    boundaryKind: policy.boundaryKind === 'policy_only'
      ? 'policy_only'
      : policy.boundaryKind === 'mixed'
        ? 'mixed'
        : policy.boundaryKind === 'hard'
          ? 'hard'
          : 'none',
    enforcedFeatures: {
      network: policy.enforcedFeatures?.network === true,
      writePaths: policy.enforcedFeatures?.writePaths === true,
      readPaths: policy.enforcedFeatures?.readPaths === true,
    },
    preflightEnforcedFeatures: Array.isArray(policy.preflightEnforcedFeatures)
      ? policy.preflightEnforcedFeatures.filter((feature): feature is 'network' | 'writePaths' | 'readPaths' =>
        feature === 'network' || feature === 'writePaths' || feature === 'readPaths')
      : [],
    hardEnforcedFeatures: Array.isArray(policy.hardEnforcedFeatures)
      ? policy.hardEnforcedFeatures.filter((feature): feature is 'network' | 'writePaths' | 'readPaths' =>
        feature === 'network' || feature === 'writePaths' || feature === 'readPaths')
      : [],
    policyOnlyFeatures: Array.isArray(policy.policyOnlyFeatures)
      ? policy.policyOnlyFeatures.filter((feature): feature is 'network' | 'writePaths' | 'readPaths' =>
        feature === 'network' || feature === 'writePaths' || feature === 'readPaths')
      : [],
    allowWritePaths: Array.isArray(policy.allowWritePaths)
      ? policy.allowWritePaths.filter((path): path is string => typeof path === 'string')
      : [],
    denyReadPaths: Array.isArray(policy.denyReadPaths)
      ? policy.denyReadPaths.filter((path): path is string => typeof path === 'string')
      : [],
    denyWritePaths: Array.isArray(policy.denyWritePaths)
      ? policy.denyWritePaths.filter((path): path is string => typeof path === 'string')
      : [],
    networkDisabled: policy.networkDisabled === true,
    bypassRequested: policy.bypassRequested === true,
    bypassAllowed: policy.bypassAllowed === true,
    ...(typeof policy.reason === 'string' ? { reason: policy.reason } : {}),
  };
}

function validateBashPreflight(
  command: string,
  cwd: string,
  policy: BashSandboxExecutionPolicy | undefined,
) : BashSandboxPreflightFinding | null {
  if (!policy?.enforce) return null;

  if (policy.bypassRequested) {
    if (policy.bypassAllowed) return null;
    return {
      phase: 'preflight',
      stage: 'preflight',
      scope: 'sandbox',
      code: 'bypass_not_approved',
      feature: 'bypass',
      severity: 'error',
      message: policy.reason ?? 'Sandbox bypass requested but not explicitly approved.',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    };
  }

  if (policy.networkDisabled && usesNetwork(command)) {
    return {
      phase: 'preflight',
      stage: 'preflight',
      scope: 'network',
      code: 'network_disabled',
      feature: 'network',
      severity: 'error',
      message: 'Sandbox policy blocked command: network access is disabled.',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    };
  }

  const hasWritePathRules = policy.allowWritePaths.length > 0 || policy.denyWritePaths.length > 0;
  if (hasWritePathRules) {
    const writeTargets = extractWriteTargets(command, cwd);
    for (const target of writeTargets) {
      if (policy.denyWritePaths.some((denied) => isPathInside(target, denied))) {
        return {
          phase: 'preflight',
          stage: 'preflight',
          scope: 'filesystem',
          code: 'write_denied',
          feature: 'writePaths',
          severity: 'error',
          message: `Sandbox policy blocked write to denied path: ${target}`,
          target,
          executionEngine: policy.executionEngine,
          boundaryKind: policy.boundaryKind,
        };
      }
      if (
        policy.allowWritePaths.length > 0 &&
        !policy.allowWritePaths.some((allowed) => isPathInside(target, allowed))
      ) {
        return {
          phase: 'preflight',
          stage: 'preflight',
          scope: 'filesystem',
          code: 'write_outside_allowed_paths',
          feature: 'writePaths',
          severity: 'error',
          message: `Sandbox policy blocked write outside allowed paths: ${target}`,
          target,
          executionEngine: policy.executionEngine,
          boundaryKind: policy.boundaryKind,
        };
      }
    }
  }

  if (policy.denyReadPaths.length > 0) {
    const readTargets = extractReadTargets(command, cwd);
    for (const target of readTargets) {
      if (policy.denyReadPaths.some((denied) => isPathInside(target, denied))) {
        return {
          phase: 'preflight',
          stage: 'preflight',
          scope: 'filesystem',
          code: 'read_denied',
          feature: 'readPaths',
          severity: 'error',
          message: `Sandbox policy blocked read from denied path: ${target}`,
          target,
          executionEngine: policy.executionEngine,
          boundaryKind: policy.boundaryKind,
        };
      }
    }
  }

  return null;
}

function collectSandboxFindings(
  policy: BashSandboxExecutionPolicy | undefined,
  runtimeFinding: BashSandboxExecutionFinding | null = null,
): BashSandboxExecutionFinding[] {
  const findings = [...(policy?.findings ?? [])];
  if (runtimeFinding) findings.push(runtimeFinding);
  return findings;
}

function createSandboxExecutionProvenance(
  ctx: ToolContext,
  input: {
    command: string;
    cwd: string;
    runInBackground: boolean;
    policy: BashSandboxExecutionPolicy | undefined;
    wrappedWithSandboxExec: boolean;
  },
): BashSandboxExecutionProvenance {
  return {
    sessionId: ctx.sessionId,
    toolUseId: ctx.toolUseId,
    cwd: input.cwd,
    command: input.command,
    runInBackground: input.runInBackground,
    executionEngine: input.policy?.executionEngine ?? 'none',
    boundaryKind: input.policy?.boundaryKind ?? 'none',
    enforcedFeatures: input.policy?.enforcedFeatures ?? {
      network: false,
      writePaths: false,
      readPaths: false,
    },
    preflightEnforcedFeatures: input.policy?.preflightEnforcedFeatures ?? [],
    hardEnforcedFeatures: input.policy?.hardEnforcedFeatures ?? [],
    policyOnlyFeatures: input.policy?.policyOnlyFeatures ?? [],
    bypassRequested: input.policy?.bypassRequested ?? false,
    bypassAllowed: input.policy?.bypassAllowed ?? false,
    wrappedWithSandboxExec: input.wrappedWithSandboxExec,
  };
}

function buildSandboxExecutionRecord(input: {
  ctx: ToolContext;
  command: string;
  cwd: string;
  runInBackground: boolean;
  policy: BashSandboxExecutionPolicy | undefined;
  outcome: BashSandboxExecutionRecord['outcome'];
  wrappedWithSandboxExec?: boolean;
  exitCode?: number | null;
  finalCwd?: string | null;
  outputLength?: number;
  backgroundTaskId?: string;
  findings: BashSandboxExecutionFinding[];
}): BashSandboxExecutionRecord {
  return {
    timestamp: new Date().toISOString(),
    outcome: input.outcome,
    provenance: createSandboxExecutionProvenance(input.ctx, {
      command: input.command,
      cwd: input.cwd,
      runInBackground: input.runInBackground,
      policy: input.policy,
      wrappedWithSandboxExec: input.wrappedWithSandboxExec === true,
    }),
    findings: input.findings,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.finalCwd !== undefined ? { finalCwd: input.finalCwd } : {}),
    ...(input.outputLength !== undefined ? { outputLength: input.outputLength } : {}),
    ...(input.backgroundTaskId !== undefined ? { backgroundTaskId: input.backgroundTaskId } : {}),
  };
}

function createSandboxExecutionDiagnostic(record: BashSandboxExecutionRecord): Record<string, unknown> {
  const finding = [...record.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
  return {
    code: 'bash_sandbox_execution',
    message: finding
      ? `${record.outcome}: ${finding.code} - ${finding.message}`
      : `bash sandbox ${record.outcome}`,
    severity: finding?.severity ?? (record.outcome === 'success' || record.outcome === 'started' ? 'info' : 'warning'),
    source: 'runtime',
    payload: record,
  };
}

function appendSandboxExecutionDiagnostic(ctx: ToolContext, record: BashSandboxExecutionRecord): void {
  if (!ctx.setAppState) return;
  const diagnostic = createSandboxExecutionDiagnostic(record);
  ctx.setAppState((prev) => {
    if (!prev?.runtime) return prev;
    return {
      ...prev,
      runtime: {
        ...prev.runtime,
        diagnostics: [...prev.runtime.diagnostics, diagnostic],
      },
    };
  });
}

function severityRank(severity: BashSandboxExecutionFinding['severity']): number {
  switch (severity) {
    case 'error':
      return 3;
    case 'warning':
      return 2;
    default:
      return 1;
  }
}

function detectSandboxRuntimeViolation(
  stderr: string,
  policy: BashSandboxExecutionPolicy | undefined,
  exitCode?: number | null,
): BashSandboxExecutionFinding | null {
  const trimmed = stderr.trim();
  if (!policy?.enforce || trimmed.length === 0) return null;

  if (policy.networkDisabled && /Operation not permitted|network|connect|socket|Permission denied/i.test(trimmed)) {
    return {
      stage: 'runtime',
      scope: 'network',
      code: 'network_restricted_runtime',
      severity: 'error',
      message: trimmed,
    };
  }

  if ((policy.allowWritePaths.length > 0 || policy.denyWritePaths.length > 0) &&
    /Operation not permitted|Permission denied|read-only file system|sandbox/i.test(trimmed)) {
    return {
      stage: 'runtime',
      scope: 'filesystem',
      code: 'filesystem_restricted_runtime',
      severity: 'error',
      message: trimmed,
    };
  }

  if (exitCode !== undefined && exitCode !== null && exitCode !== 0 && /sandbox/i.test(trimmed)) {
    return {
      stage: 'runtime',
      scope: 'execution',
      code: 'sandbox_runtime_failure',
      severity: 'warning',
      message: trimmed,
    };
  }

  return null;
}

function buildSandboxEnv(policy: BashSandboxExecutionPolicy | undefined): Record<string, string> {
  if (!policy) return {};
  return {
    OPEN_AGENT_SANDBOX: policy.enforce ? '1' : '0',
    OPEN_AGENT_SANDBOX_EXECUTION_ENGINE: policy.executionEngine,
    OPEN_AGENT_SANDBOX_BOUNDARY_KIND: policy.boundaryKind,
    OPEN_AGENT_SANDBOX_ENFORCED_FEATURES: [
      policy.enforcedFeatures.network ? 'network' : '',
      policy.enforcedFeatures.writePaths ? 'write-paths' : '',
      policy.enforcedFeatures.readPaths ? 'read-paths' : '',
    ].filter(Boolean).join(','),
    OPEN_AGENT_SANDBOX_PREFLIGHT_ENFORCED_FEATURES: policy.preflightEnforcedFeatures.join(','),
    OPEN_AGENT_SANDBOX_HARD_ENFORCED_FEATURES: policy.hardEnforcedFeatures.join(','),
    OPEN_AGENT_SANDBOX_POLICY_ONLY_FEATURES: policy.policyOnlyFeatures.join(','),
    OPEN_AGENT_SANDBOX_NETWORK_DISABLED: policy.networkDisabled ? '1' : '0',
    OPEN_AGENT_SANDBOX_ALLOW_WRITE_PATHS: policy.allowWritePaths.join(':'),
    OPEN_AGENT_SANDBOX_DENY_READ_PATHS: policy.denyReadPaths.join(':'),
    OPEN_AGENT_SANDBOX_DENY_WRITE_PATHS: policy.denyWritePaths.join(':'),
    OPEN_AGENT_SANDBOX_BYPASS_REQUESTED: policy.bypassRequested ? '1' : '0',
    OPEN_AGENT_SANDBOX_BYPASS_ALLOWED: policy.bypassAllowed ? '1' : '0',
    OPEN_AGENT_SANDBOX_REASON: policy.reason ?? '',
  };
}

function wrapWithSandboxExec(
  command: string[],
  policy: BashSandboxExecutionPolicy | undefined,
): { command: string; args: string[] } {
  if (!policy?.enforce || policy.bypassRequested || policy.executionEngine !== 'darwin-sandbox-exec') {
    return { command: command[0]!, args: command.slice(1) };
  }
  if (!existsSync(DARWIN_SANDBOX_EXEC)) {
    return { command: command[0]!, args: command.slice(1) };
  }

  const profile = buildDarwinSandboxProfile(policy);
  return {
    command: DARWIN_SANDBOX_EXEC,
    args: ['-p', profile, ...command],
  };
}

function buildDarwinSandboxProfile(policy: BashSandboxExecutionPolicy): string {
  const rules = [
    '(version 1)',
    '(allow default)',
  ];

  if (policy.networkDisabled) {
    rules.push('(deny network*)');
  }

  if (policy.allowWritePaths.length > 0) {
    rules.push('(deny file-write*)');
    for (const allowedPath of policy.allowWritePaths) {
      rules.push(`(allow file-write* (subpath "${escapeSandboxString(allowedPath)}"))`);
    }
  }

  for (const deniedPath of policy.denyWritePaths) {
    rules.push(`(deny file-write* (subpath "${escapeSandboxString(deniedPath)}"))`);
  }

  return rules.join('\n');
}

function escapeSandboxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function usesNetwork(command: string): boolean {
  const directNetwork = /\b(curl|wget|ssh|scp|sftp|nc|ncat|telnet|ping|ftp|rsync)\b/i;
  const gitRemote = /\bgit\s+(clone|fetch|pull|push|ls-remote|remote|submodule)\b/i;
  const urlLike = /\b(?:https?|ftp):\/\//i;
  return directNetwork.test(command) || gitRemote.test(command) || urlLike.test(command);
}

function extractWriteTargets(command: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const segments = command.split(/(?:&&|\|\||;|\n)/).map((segment) => segment.trim()).filter(Boolean);

  for (const segment of segments) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (isRedirectionToken(token)) {
        const next = tokens[i + 1];
        if (next) addWriteTarget(candidates, next, cwd);
        continue;
      }
      const inlineRedirect = extractInlineRedirectTarget(token);
      if (inlineRedirect) addWriteTarget(candidates, inlineRedirect, cwd);
      if (/^of=/.test(token)) {
        addWriteTarget(candidates, token.slice(3), cwd);
      }
    }

    const commandName = stripWrappingQuotes(tokens[0]);
    const args = tokens.slice(1);
    switch (commandName) {
      case 'touch':
      case 'mkdir':
      case 'rm':
      case 'rmdir':
      case 'truncate':
      case 'chmod':
      case 'chown':
        for (const arg of args) {
          if (isOptionToken(arg)) continue;
          addWriteTarget(candidates, arg, cwd);
        }
        break;
      case 'tee':
        for (const arg of args) {
          if (isOptionToken(arg) || arg === '-') continue;
          addWriteTarget(candidates, arg, cwd);
        }
        break;
      case 'cp':
      case 'mv':
      case 'install':
      case 'ln': {
        const targets = args.filter((arg) => !isOptionToken(arg));
        const destination = targets[targets.length - 1];
        if (destination) addWriteTarget(candidates, destination, cwd);
        break;
      }
      case 'sed': {
        const hasInPlace = args.some((arg) => /^-i($|['"])/.test(arg) || arg === '--in-place');
        if (hasInPlace) {
          for (const arg of args) {
            if (isOptionToken(arg)) continue;
            addWriteTarget(candidates, arg, cwd);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return [...candidates];
}

function extractReadTargets(command: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const segments = command.split(/(?:&&|\|\||;|\n)/).map((segment) => segment.trim()).filter(Boolean);

  for (const segment of segments) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      if (!isInputRedirectionToken(tokens[i])) continue;
      const next = tokens[i + 1];
      if (next) addReadTarget(candidates, next, cwd);
    }

    const commandName = stripWrappingQuotes(tokens[0]);
    const args = tokens.slice(1);
    switch (commandName) {
      case 'cat':
      case 'head':
      case 'tail':
      case 'less':
      case 'more':
      case 'bat':
      case 'sed':
      case 'awk':
      case 'cut':
      case 'sort':
      case 'uniq':
      case 'wc':
      case 'file':
      case 'strings':
      case 'nl':
      case 'rg':
      case 'grep':
      case 'egrep':
      case 'fgrep':
        for (const arg of args) {
          if (isOptionToken(arg)) continue;
          addReadTarget(candidates, arg, cwd);
        }
        break;
      case 'cp':
      case 'mv':
      case 'install': {
        const positional = args.filter((arg) => !isOptionToken(arg));
        for (const arg of positional.slice(0, -1)) {
          addReadTarget(candidates, arg, cwd);
        }
        break;
      }
      default:
        break;
    }
  }

  return [...candidates];
}

function tokenizeShell(segment: string): string[] {
  const matches = segment.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+/g);
  return matches ?? [];
}

function addWriteTarget(targets: Set<string>, raw: string, cwd: string): void {
  addShellTarget(targets, raw, cwd);
}

function addReadTarget(targets: Set<string>, raw: string, cwd: string): void {
  addShellTarget(targets, raw, cwd);
}

function addShellTarget(targets: Set<string>, raw: string, cwd: string): void {
  const cleaned = stripWrappingQuotes(raw.trim());
  if (!cleaned || cleaned === '-') return;
  if (
    cleaned.includes('$') ||
    cleaned.includes('*') ||
    cleaned.includes('?') ||
    cleaned.includes('[') ||
    cleaned.includes('`')
  ) {
    return;
  }
  const normalized = resolve(cwd, cleaned);
  targets.add(normalized);
}

function stripWrappingQuotes(token: string): string {
  if (token.length < 2) return token;
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith('\'') && token.endsWith('\''))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function isRedirectionToken(token: string): boolean {
  return /^(?:\d?>>?|&>|2>|1>)$/.test(token);
}

function isInputRedirectionToken(token: string): boolean {
  return /^(?:\d?<)$/.test(token);
}

function extractInlineRedirectTarget(token: string): string | null {
  const match = token.match(/^(?:\d?>>?|&>)(.+)$/);
  if (!match) return null;
  return match[1];
}

function isOptionToken(token: string): boolean {
  return token.startsWith('-');
}

function isPathInside(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = resolve(candidatePath);
  const normalizedBase = resolve(basePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(normalizedBase.endsWith(sep) ? normalizedBase : `${normalizedBase}${sep}`)
  );
}
