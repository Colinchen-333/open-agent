import type { HookEvent } from '@open-agent/core';
import { spawnProcess } from '@open-agent/core';
import { withCamelCaseAliases } from './camel-case-compat';
import type {
  AgentHookDefinition,
  AnyHookDefinition,
  HookCallbackMatcher,
  HookDefinition,
  HttpHookDefinition,
  HookInput,
  HookOutput,
  PromptHookDefinition,
} from './types';

// Module-level cache for compiled RegExp objects to avoid recompilation per execution.
const regexpCache = new Map<string, RegExp>();

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
  private shellHooks: Map<HookEvent, Array<{ hook: HookDefinition; sourceId?: string }>> = new Map();
  private promptHooks: Map<HookEvent, Array<{ hook: PromptHookDefinition; sourceId?: string }>> = new Map();
  private httpHooks: Map<HookEvent, Array<{ hook: HttpHookDefinition; sourceId?: string }>> = new Map();
  private agentHooks: Map<HookEvent, Array<{ hook: AgentHookDefinition; sourceId?: string }>> = new Map();
  private callbackHooks: Map<HookEvent, HookCallbackMatcher[]> = new Map();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /** Register a shell-command hook for the given event. */
  registerShellHook(event: HookEvent, hook: HookDefinition, sourceId?: string): void {
    const existing = this.shellHooks.get(event) ?? [];
    existing.push({ hook, sourceId });
    this.shellHooks.set(event, existing);
  }

  /** Register a prompt-injection hook for the given event. */
  registerPromptHook(event: HookEvent, hook: PromptHookDefinition, sourceId?: string): void {
    const existing = this.promptHooks.get(event) ?? [];
    existing.push({ hook, sourceId });
    this.promptHooks.set(event, existing);
  }

  /** Register an HTTP webhook hook for the given event. */
  registerHttpHook(event: HookEvent, hook: HttpHookDefinition, sourceId?: string): void {
    const existing = this.httpHooks.get(event) ?? [];
    existing.push({ hook, sourceId });
    this.httpHooks.set(event, existing);
  }

  /** Register an agent-spawn hook for the given event. */
  registerAgentHook(event: HookEvent, hook: AgentHookDefinition, sourceId?: string): void {
    const existing = this.agentHooks.get(event) ?? [];
    existing.push({ hook, sourceId });
    this.agentHooks.set(event, existing);
  }

  /** Register one or more callback functions for the given event. */
  registerCallbackHook(event: HookEvent, matcher: HookCallbackMatcher): void {
    const existing = this.callbackHooks.get(event) ?? [];
    existing.push(matcher);
    this.callbackHooks.set(event, existing);
  }

  /**
   * Register any hook definition by inspecting its `type` discriminant.
   * Shell hooks (legacy, no `type` field) are routed to `registerShellHook`.
   */
  registerHook(event: HookEvent, hook: AnyHookDefinition, sourceId?: string): void {
    if (!('type' in hook)) {
      this.registerShellHook(event, hook, sourceId);
    } else if (hook.type === 'prompt') {
      this.registerPromptHook(event, hook, sourceId);
    } else if (hook.type === 'http') {
      this.registerHttpHook(event, hook, sourceId);
    } else if (hook.type === 'agent') {
      this.registerAgentHook(event, hook, sourceId);
    }
  }

  /**
   * Load shell hooks from a plain config object of the shape:
   *   { [event: HookEvent]: HookDefinition[] }
   */
  loadFromConfig(config: Partial<Record<HookEvent, HookDefinition[]>>, sourceId?: string): void {
    for (const [event, hooks] of Object.entries(config) as [HookEvent, HookDefinition[]][]) {
      for (const hook of hooks) {
        this.registerShellHook(event, hook, sourceId);
      }
    }
  }

  /**
   * Load any mix of hook definitions from a plain config object of the shape:
   *   { [event: HookEvent]: AnyHookDefinition[] }
   * Routes each entry to the correct typed registry based on its `type` field.
   */
  loadAnyFromConfig(
    config: Partial<Record<HookEvent, AnyHookDefinition[]>>,
    sourceId?: string,
  ): void {
    for (const [event, hooks] of Object.entries(config) as [HookEvent, AnyHookDefinition[]][]) {
      for (const hook of hooks) {
        this.registerHook(event, hook, sourceId);
      }
    }
  }

  replaceShellHooksFromConfig(
    config: Partial<Record<HookEvent, HookDefinition[]>>,
    sourceId?: string,
  ): void {
    if (sourceId === undefined) {
      this.shellHooks.clear();
      this.loadFromConfig(config);
      return;
    }

    for (const [event, hooks] of this.shellHooks.entries()) {
      const kept = hooks.filter((entry) => entry.sourceId !== sourceId);
      if (kept.length === 0) {
        this.shellHooks.delete(event);
      } else {
        this.shellHooks.set(event, kept);
      }
    }

    this.loadFromConfig(config, sourceId);
  }

  getHookSurface(): Array<{ event: HookEvent; count: number; sources: string[] }> {
    const events = new Set<HookEvent>([
      ...this.shellHooks.keys(),
      ...this.promptHooks.keys(),
      ...this.httpHooks.keys(),
      ...this.agentHooks.keys(),
      ...this.callbackHooks.keys(),
    ]);

    return [...events]
      .sort((a, b) => a.localeCompare(b))
      .map((event) => {
        const shellHooks = this.shellHooks.get(event) ?? [];
        const promptHooks = this.promptHooks.get(event) ?? [];
        const httpHooks = this.httpHooks.get(event) ?? [];
        const agentHooks = this.agentHooks.get(event) ?? [];
        const callbackHooks = this.callbackHooks.get(event) ?? [];
        const callbackCount = callbackHooks.reduce((sum, matcher) => sum + matcher.hooks.length, 0);
        const sources = new Set<string>();

        for (const entry of shellHooks) {
          sources.add(entry.sourceId ?? 'shell');
        }
        for (const entry of promptHooks) {
          sources.add(entry.sourceId ?? 'prompt');
        }
        for (const entry of httpHooks) {
          sources.add(entry.sourceId ?? 'http');
        }
        for (const entry of agentHooks) {
          sources.add(entry.sourceId ?? 'agent');
        }
        if (callbackCount > 0) {
          sources.add('callback');
        }

        return {
          event,
          count: shellHooks.length + promptHooks.length + httpHooks.length + agentHooks.length + callbackCount,
          sources: [...sources].sort(),
        };
      });
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
    for (const shellHook of shellHooks) {
      const hook = shellHook.hook;
      if (!this.matchesHook(hook, input)) continue;

      // Fire-and-forget path: spawn asynchronously, return immediately.
      if (hook.asyncTimeout !== undefined) {
        this.executeShellHookAsync(hook, input).catch((err) => {
          console.error(`[HookExecutor] Async shell hook failed (${event}):`, err);
        });
        results.push({ continue: true });
        continue;
      }

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

    // -- Prompt hooks ---------------------------------------------------------
    const promptHooks = this.promptHooks.get(event) ?? [];
    for (const entry of promptHooks) {
      const hook = entry.hook;
      if (hook.matcher && !this.matchesMatcher(hook.matcher, input)) continue;
      const result = this.executePromptHook(hook, input);
      results.push(result);
      if (result.continue === false) {
        return this.mergeResults(results);
      }
    }

    // -- HTTP hooks -----------------------------------------------------------
    const httpHooks = this.httpHooks.get(event) ?? [];
    for (const entry of httpHooks) {
      const hook = entry.hook;
      if (hook.matcher && !this.matchesMatcher(hook.matcher, input)) continue;
      const timeoutMs = (hook.timeout ?? 30) * 1000;
      try {
        const result = await this.executeHttpHook(hook, input, timeoutMs);
        results.push(result);
        if (result.continue === false) {
          return this.mergeResults(results);
        }
      } catch (err) {
        console.error(`[HookExecutor] HTTP hook failed (${event}, ${hook.url}):`, err);
      }
    }

    // -- Agent hooks ----------------------------------------------------------
    const agentHooks = this.agentHooks.get(event) ?? [];
    for (const entry of agentHooks) {
      const hook = entry.hook;
      if (hook.matcher && !this.matchesMatcher(hook.matcher, input)) continue;
      const result = this.executeAgentHook(hook, input);
      results.push(result);
      if (result.continue === false) {
        return this.mergeResults(results);
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

      const enrichedInput = withCamelCaseAliases(input);
      try {
        for (const hookFn of matcherEntry.hooks) {
          const result = await hookFn(enrichedInput as any, toolUseId, { signal: ac.signal });
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
  private matchesHook(hook: AnyHookDefinition, input: HookInput): boolean {
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
      let re = regexpCache.get(pattern);
      if (!re) {
        re = new RegExp(pattern);
        regexpCache.set(pattern, re);
      }
      return re.test(toolName);
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
    // Enrich with camelCase aliases so hooks written for either convention work.
    const enrichedInput = withCamelCaseAliases(input);
    const inputJson = JSON.stringify(enrichedInput);

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

    const proc = await spawnProcess(['bash', '-c', hook.command], {
      env: extraEnv,
    });

    // Write enriched JSON to the process stdin and close the stream so the
    // process receives EOF after reading.
    proc.writeStdin(inputJson);
    proc.closeStdin();

    // Kill the process if it exceeds the timeout.
    // Send SIGTERM first, then follow up with SIGKILL after a 5s grace period.
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    try {
      [stdout, stderr] = await Promise.all([
        proc.stdoutText(),
        proc.stderrText(),
      ]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
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
   * Fire-and-forget variant: spawns the hook process and schedules a SIGTERM
   * after `hook.asyncTimeout` seconds. The returned Promise resolves once the
   * process has been started and stdin closed — the caller does NOT await the
   * process exit.
   */
  private async executeShellHookAsync(hook: HookDefinition, input: HookInput): Promise<void> {
    // Enrich with camelCase aliases so hooks written for either convention work.
    const enrichedInput = withCamelCaseAliases(input);
    const inputJson = JSON.stringify(enrichedInput);

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

    const proc = await spawnProcess(['bash', '-c', hook.command], { env: extraEnv });
    proc.writeStdin(inputJson);
    proc.closeStdin();

    // Schedule SIGTERM after asyncTimeout seconds; unref so this timer does not
    // prevent the Node/Bun process from exiting naturally.
    const asyncTimeoutMs = (hook.asyncTimeout ?? 30) * 1000;
    const timer = setTimeout(() => proc.kill('SIGTERM'), asyncTimeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }

    // When the process exits on its own, clear the timer.
    proc.exited.finally(() => clearTimeout(timer)).catch(() => {/* ignore */});
  }

  /**
   * Render a template string, replacing recognised placeholders with values
   * extracted from `input`.
   *
   * Supported placeholders:
   *   {{toolName}}  — tool_name (tool-related events only; empty string otherwise)
   *   {{event}}     — hook_event_name
   *   {{sessionId}} — session_id
   */
  private renderTemplate(template: string, input: HookInput): string {
    const toolName = 'tool_name' in input ? (input as { tool_name: string }).tool_name : '';
    return template
      .replace(/\{\{toolName\}\}/g, toolName)
      .replace(/\{\{event\}\}/g, input.hook_event_name)
      .replace(/\{\{sessionId\}\}/g, input.session_id);
  }

  /**
   * Execute a prompt hook synchronously: render the template and return the
   * result as `additionalContext` so the conversation loop can inject it into
   * the system prompt.
   */
  private executePromptHook(hook: PromptHookDefinition, input: HookInput): HookOutput {
    const rendered = this.renderTemplate(hook.template, input);
    return { continue: true, additionalContext: rendered };
  }

  /**
   * POST the serialised HookInput to `hook.url` and parse the response body as
   * a HookOutput. Non-JSON responses are surfaced as `additionalContext`.
   * Network or timeout errors are re-thrown so the caller can log and skip.
   */
  private async executeHttpHook(
    hook: HttpHookDefinition,
    input: HookInput,
    timeoutMs: number,
  ): Promise<HookOutput> {
    const enrichedInput = withCamelCaseAliases(input);
    const body = JSON.stringify(enrichedInput);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let responseText: string;
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...hook.headers,
        },
        body,
        signal: ac.signal,
      });
      responseText = await response.text();
    } finally {
      clearTimeout(timer);
    }

    const trimmed = responseText.trim();
    if (!trimmed) {
      return { continue: true };
    }

    try {
      return JSON.parse(trimmed) as HookOutput;
    } catch {
      // Non-JSON response body treated as plain additional context.
      return { continue: true, additionalContext: trimmed };
    }
  }

  /**
   * Execute an agent hook: render the optional prompt template and surface the
   * dispatch request via `hookSpecificOutput` so the caller (e.g. the
   * ConversationLoop) can spawn the named subagent.
   */
  private executeAgentHook(hook: AgentHookDefinition, input: HookInput): HookOutput {
    const renderedPrompt = hook.prompt ? this.renderTemplate(hook.prompt, input) : undefined;
    return {
      continue: true,
      hookSpecificOutput: {
        agentName: hook.agentName,
        ...(renderedPrompt !== undefined ? { prompt: renderedPrompt } : {}),
      },
    };
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
      if (result.hookSpecificOutput !== undefined) {
        merged.hookSpecificOutput = { ...merged.hookSpecificOutput, ...result.hookSpecificOutput };
      }
    }

    return merged;
  }
}
