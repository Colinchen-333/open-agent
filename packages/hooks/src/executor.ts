import type { HookEvent } from '@open-agent/core';
import type {
  HookCallbackMatcher,
  HookDefinition,
  HookInput,
  HookOutput,
} from './types';

// ---------------------------------------------------------------------------
// HookExecutor
// ---------------------------------------------------------------------------

/**
 * Central registry and execution engine for the hook system.
 *
 * Two kinds of hooks are supported:
 *   - Shell hooks: an external process is spawned via `bash -c <command>`.
 *     The serialised HookInput is written to its stdin and is also available
 *     as the HOOK_INPUT environment variable. The process should write a JSON
 *     HookOutput to stdout.
 *   - Callback hooks: TypeScript functions registered programmatically.
 *
 * Hooks within the same event are executed sequentially. If any hook returns
 * `{ continue: false }` all subsequent hooks for that event are skipped and
 * the merged result is returned immediately.
 */
export class HookExecutor {
  private shellHooks: Map<HookEvent, HookDefinition[]> = new Map();
  private callbackHooks: Map<HookEvent, HookCallbackMatcher[]> = new Map();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** Register a shell-command hook for the given event. */
  registerShellHook(event: HookEvent, hook: HookDefinition): void {
    const existing = this.shellHooks.get(event) ?? [];
    existing.push(hook);
    this.shellHooks.set(event, existing);
  }

  /** Register one or more callback functions for the given event. */
  registerCallbackHook(event: HookEvent, matcher: HookCallbackMatcher): void {
    const existing = this.callbackHooks.get(event) ?? [];
    existing.push(matcher);
    this.callbackHooks.set(event, existing);
  }

  /**
   * Load shell hooks from a plain config object of the shape:
   *   { [event: HookEvent]: HookDefinition[] }
   */
  loadFromConfig(config: Partial<Record<HookEvent, HookDefinition[]>>): void {
    for (const [event, hooks] of Object.entries(config) as [HookEvent, HookDefinition[]][]) {
      for (const hook of hooks) {
        this.registerShellHook(event, hook);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute all registered hooks for `event` in registration order.
   *
   * Shell hooks are run first, then callback hooks. Execution stops early as
   * soon as any hook returns `{ continue: false }`. All outputs are merged
   * into a single HookOutput that is returned to the caller.
   */
  async execute(
    event: HookEvent,
    input: HookInput,
    toolUseId?: string,
  ): Promise<HookOutput> {
    const results: HookOutput[] = [];

    // -- Shell hooks ----------------------------------------------------------
    const shellHooks = this.shellHooks.get(event) ?? [];
    for (const hook of shellHooks) {
      if (!this.matchesHook(hook, input)) continue;

      const timeoutMs = (hook.timeout ?? 30) * 1000;
      try {
        const result = await this.executeShellHook(hook, input, timeoutMs);
        results.push(result);
        if (result.continue === false) {
          return this.mergeResults(results);
        }
      } catch (err) {
        console.error(`[HookExecutor] Shell hook failed (${event}):`, err);
      }
    }

    // -- Callback hooks -------------------------------------------------------
    const callbackMatchers = this.callbackHooks.get(event) ?? [];
    for (const matcherEntry of callbackMatchers) {
      if (matcherEntry.matcher && !this.matchesMatcher(matcherEntry.matcher, input)) {
        continue;
      }

      const timeoutMs = (matcherEntry.timeout ?? 30) * 1000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      try {
        for (const hookFn of matcherEntry.hooks) {
          const result = await hookFn(input, toolUseId, { signal: ac.signal });
          results.push(result);
          if (result.continue === false) {
            clearTimeout(timer);
            return this.mergeResults(results);
          }
        }
      } catch (err) {
        console.error(`[HookExecutor] Callback hook failed (${event}):`, err);
      } finally {
        clearTimeout(timer);
      }
    }

    return this.mergeResults(results);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns true when the hook's matcher (if any) matches the current input.
   * For tool-related events the matcher is tested against `tool_name`;
   * for all other events an absent matcher always matches.
   */
  private matchesHook(hook: HookDefinition, input: HookInput): boolean {
    if (!hook.matcher) return true;
    return this.matchesMatcher(hook.matcher, input);
  }

  /**
   * Tests `pattern` against `tool_name` (exact match first, then regex).
   * Returns true for non-tool events because there is nothing to match against.
   */
  private matchesMatcher(pattern: string, input: HookInput): boolean {
    if (!('tool_name' in input)) return true;
    const toolName = (input as { tool_name: string }).tool_name;
    if (toolName === pattern) return true;
    try {
      return new RegExp(pattern).test(toolName);
    } catch {
      // Invalid regex — treat as no match to avoid silent breakage.
      console.warn(`[HookExecutor] Invalid matcher pattern: "${pattern}"`);
      return false;
    }
  }

  /**
   * Spawn `bash -c <command>`, pipe the serialised input to stdin, wait for
   * the process to finish (or be killed by the timeout), then parse stdout as
   * a HookOutput JSON object.
   *
   * If stdout is empty or not valid JSON the hook is treated as a no-op that
   * allows execution to continue. Any stdout text that is not JSON is attached
   * as `additionalContext` so it can still surface useful information.
   */
  private async executeShellHook(
    hook: HookDefinition,
    input: HookInput,
    timeoutMs: number,
  ): Promise<HookOutput> {
    const inputJson = JSON.stringify(input);

    // Build convenience env vars so shell hooks can access common fields without
    // parsing the full HOOK_INPUT JSON.
    const extraEnv: Record<string, string> = {
      HOOK_INPUT: inputJson,
      HOOK_EVENT: input.hook_event_name,
    };
    if ('tool_name' in input) {
      extraEnv.HOOK_TOOL_NAME = (input as { tool_name: string }).tool_name;
    }
    if ('tool_input' in input) {
      try {
        extraEnv.HOOK_TOOL_INPUT = JSON.stringify((input as { tool_input: unknown }).tool_input);
      } catch {
        extraEnv.HOOK_TOOL_INPUT = '';
      }
    }

    const proc = Bun.spawn(['bash', '-c', hook.command], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    // Write input JSON to the process stdin and close the stream so the
    // process receives EOF after reading.
    // Bun's FileSink exposes write() / flush() / end() — not getWriter().
    proc.stdin.write(inputJson);
    proc.stdin.flush();
    proc.stdin.end();

    // Kill the process if it exceeds the timeout.
    const timer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (stderr.trim()) {
      console.error(`[HookExecutor] Hook stderr (${hook.command}):\n${stderr.trim()}`);
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { continue: true };
    }

    try {
      return JSON.parse(trimmed) as HookOutput;
    } catch {
      // Non-JSON stdout is surfaced as additional context rather than ignored.
      return { continue: true, additionalContext: trimmed };
    }
  }

  /**
   * Merge an ordered list of HookOutput objects into a single result.
   *
   * Rules:
   *  - `continue` is false if ANY result set it to false.
   *  - `suppressOutput` is true if ANY result set it to true.
   *  - Last writer wins for: `stopReason`, `decision`, `systemMessage`,
   *    `reason`, `permissionDecision`.
   *  - `additionalContext` values are concatenated with a newline separator.
   *  - `updatedInput` objects are shallow-merged in order (later values win).
   */
  private mergeResults(results: HookOutput[]): HookOutput {
    if (results.length === 0) return { continue: true };

    const merged: HookOutput = { continue: true };

    for (const result of results) {
      if (result.continue === false) merged.continue = false;
      if (result.suppressOutput) merged.suppressOutput = true;
      if (result.stopReason !== undefined) merged.stopReason = result.stopReason;
      if (result.decision !== undefined) merged.decision = result.decision;
      if (result.systemMessage !== undefined) merged.systemMessage = result.systemMessage;
      if (result.reason !== undefined) merged.reason = result.reason;
      if (result.permissionDecision !== undefined) {
        merged.permissionDecision = result.permissionDecision;
      }
      if (result.additionalContext !== undefined) {
        merged.additionalContext = merged.additionalContext
          ? `${merged.additionalContext}\n${result.additionalContext}`
          : result.additionalContext;
      }
      if (result.updatedInput !== undefined) {
        merged.updatedInput = { ...merged.updatedInput, ...result.updatedInput };
      }
    }

    return merged;
  }
}
