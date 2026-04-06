import type { PermissionMode, PermissionBehavior } from '@open-agent/core';
import { feature } from '@open-agent/core';
import type {
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  SandboxConfig,
} from './types';
import { classifyBashCommand, type BashRiskClassification } from './bash-policy.js';
import { runPipeline, type PipelineContext, type PipelineStage } from './pipeline.js';
import { classifyPermissionRequest, type ClassifierContext, type LLMClassifierProvider } from './classifier.js';
import { getPermanentRules } from './rule-persistence.js';

// Read-only tools that are always safe for informational access
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// Tools allowed automatically in acceptEdits mode
const EDIT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// Tools that are always safe regardless of mode (never destructive)
const SAFE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// File-system tools that operate on paths — subject to allowedPaths/deniedPaths checks
const FILE_SYSTEM_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

function isMetadataReadOnly(request: PermissionRequest): boolean {
  return request.metadata?.readOnly === true;
}

function isMetadataDestructive(request: PermissionRequest): boolean {
  return request.metadata?.destructive === true || request.metadata?.capability?.risk === 'high';
}

function isMetadataOpenWorld(request: PermissionRequest): boolean {
  return request.metadata?.openWorld === true;
}

function dynamicReadOnlyReason(request: PermissionRequest): string {
  const source = request.metadata?.source === 'mcp' ? 'read-only MCP tool' : 'read-only tool';
  return `${source}${request.metadata?.serverName ? ` from ${request.metadata.serverName}` : ''}`;
}

const DANGEROUS_BASH_ALLOW_PREFIXES = [
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'perl',
  'php',
  'lua',
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
] as const;

function normalizeRuleKey(rule: PermissionRule): string {
  return `${rule.toolName}\u0000${rule.ruleContent ?? ''}`;
}

function isDangerousBashAllowRule(rule: PermissionRule): boolean {
  if (rule.toolName !== 'Bash') {
    return false;
  }
  if (rule.ruleContent === undefined || rule.ruleContent.trim() === '') {
    return true;
  }
  const content = rule.ruleContent.trim().toLowerCase();
  if (content === '*') {
    return true;
  }
  return DANGEROUS_BASH_ALLOW_PREFIXES.some((prefix) => (
    content === prefix
    || content === `${prefix}:*`
    || content === `${prefix}*`
    || content === `${prefix} *`
    || (content.startsWith(`${prefix} -`) && content.endsWith('*'))
  ));
}

function isDangerousClassifierAllowRule(rule: PermissionRule): boolean {
  if (rule.toolName === '*') {
    return true;
  }
  if (rule.toolName === 'Task' || rule.toolName === 'Agent' || rule.toolName === 'PowerShell') {
    return true;
  }
  return isDangerousBashAllowRule(rule);
}

// Tools permitted in plan mode (read-only, no mutations or execution)
const PLAN_MODE_READONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ListMcpResources',
  'ReadMcpResource',
  'AskUserQuestion',
]);

export class PermissionEngine {
  private mode: PermissionMode;
  private modeStack: PermissionMode[] = [];
  private rules: {
    allow: PermissionRule[];
    deny: PermissionRule[];
    ask: PermissionRule[];
  };
  private suspendedAllowRules: PermissionRule[];
  private sandbox: SandboxConfig;
  private allowedPaths: string[];
  private deniedPaths: string[];
  private _permissionPromptToolName?: string;

  /** Semantic allow entries registered by ExitPlanModeV2. Consumed by the classifier stage (L23). */
  private allowedPrompts: Array<{ tool: string; prompt: string }> = [];

  /** Recent user messages from the transcript. Populated by ConversationLoop after each user turn. */
  private recentUserMessages: string[] = [];

  /** Hook executor for PreToolUse stage. Set via setHookExecutor(). */
  private hookExecutor?: { run(event: string, input: unknown): Promise<any> };

  /** LLM provider for the classifier stage. Set via setLLMProvider(). */
  private llmProvider?: LLMClassifierProvider;

  /** Session ID forwarded to hook payloads. */
  private sessionId?: string;

  /** Working directory forwarded to hook payloads. */
  private cwd?: string;

  /** @internal test instrumentation — set to a callback to observe pipeline stage execution order */
  public __trace?: (stage: PipelineStage) => void;

  constructor(config?: Partial<PermissionConfig & { sandbox: SandboxConfig }>) {
    this.mode = config?.mode ?? 'default';
    this.rules = {
      allow: config?.allowRules ?? [],
      deny: config?.denyRules ?? [],
      ask: config?.askRules ?? [],
    };
    this.suspendedAllowRules = [];
    this.sandbox = config?.sandbox ?? { enabled: false };
    this.allowedPaths = config?.allowedPaths ?? [];
    this.deniedPaths = config?.deniedPaths ?? [];
    this.reconcileDangerousAllowRulesForMode();

    // Hydrate permanent rules persisted from prior sessions.
    try {
      const saved = getPermanentRules();
      for (const rule of saved) {
        this.addRule(rule.behavior, { toolName: rule.toolName, ruleContent: rule.ruleContent });
      }
    } catch {
      // Non-fatal — rule persistence is best-effort.
    }
  }

  /**
   * Evaluate a permission request and return the decision.
   *
   * The evaluation runs through an explicit 6-stage pipeline in order:
   *   1. validateInput    — sandbox enforcement + file path restrictions
   *   2. alwaysDeny       — plan mode deny + explicit deny rules
   *   3. alwaysAllow      — bypassPermissions + plan mode allow + allow rules
   *   4. preToolUseHooks  — pre-tool-use hook results (stub; returns undefined)
   *   5. classifier       — ML/heuristic classifier (stub; returns undefined)
   *   6. prompt           — ask rules + mode-specific heuristics (always resolves)
   *
   * The first stage that returns a PermissionDecision short-circuits the
   * pipeline. The `prompt` stage always returns a decision, so the pipeline
   * will never fall through to the error throw in `runPipeline`.
   */
  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    return runPipeline({ request, trace: this.__trace }, [
      ['validateInput',   (ctx) => this.stageValidateInput(ctx)],
      ['alwaysDeny',      (ctx) => this.stageAlwaysDeny(ctx)],
      ['alwaysAllow',     (ctx) => this.stageAlwaysAllow(ctx)],
      ['preToolUseHooks', (ctx) => this.stagePreToolUseHooks(ctx)],
      ['classifier',      (ctx) => this.stageClassifier(ctx)],
      ['prompt',          (ctx) => this.stagePrompt(ctx)],
    ]);
  }

  // ── Pipeline stage methods ───────────────────────────────────────────────────

  /**
   * Stage 1 — validateInput
   *
   * Enforces hard infrastructure constraints before any policy logic:
   *   - Sandbox filesystem read/write restrictions
   *   - File path allowlist / denylist restrictions
   *
   * Note: bypassPermissions is intentionally NOT handled here so that sandbox
   * and path constraints remain enforced even when that mode is active (matching
   * the original evaluation order where bypassPermissions precedes these checks).
   * bypassPermissions is instead handled in stageAlwaysAllow so that the
   * pipeline always runs all 6 stages for observability.
   *
   * For a request that does not trigger any constraint this stage returns
   * undefined and the pipeline continues to the next stage.
   */
  private async stageValidateInput(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    const { request } = ctx;

    // Plan mode downgrade — deny any tool that is not in the read-only allowlist.
    // This runs before sandbox/path checks so plan mode is always enforced,
    // even when sandbox is active.
    if (this.mode === 'plan') {
      if (!PLAN_MODE_READONLY_TOOLS.has(request.toolName)) {
        // Also allow MCP tools that are read-only, non-destructive, and not open-world.
        const isReadOnlyMcp =
          isMetadataReadOnly(request) &&
          !isMetadataDestructive(request) &&
          !isMetadataOpenWorld(request);
        if (!isReadOnlyMcp) {
          return {
            behavior: 'deny',
            reason: `plan mode: tool "${request.toolName}" is not permitted (read-only tools only)`,
          };
        }
      }
    }

    // Bash semantic pre-classification — stash the classification on ctx so
    // downstream stages (alwaysAllow, prompt) can reuse it without re-classifying.
    if (
      request.toolName === 'Bash' &&
      typeof request.input === 'object' &&
      request.input !== null
    ) {
      const cmd = String((request.input as Record<string, unknown>).command ?? '');
      if (cmd) {
        (ctx as any).bashClassification = classifyBashCommand(cmd);
      }
    }

    // Sandbox enforcement — file system + auto-allow bash if sandboxed.
    if (this.sandbox.enabled) {
      const sandboxDecision = this.checkSandbox(request);
      if (sandboxDecision) return sandboxDecision;
    }

    // File system path restrictions — deny if the requested path violates
    // configured allowedPaths / deniedPaths.
    if (FILE_SYSTEM_TOOLS.includes(request.toolName)) {
      const pathDecision = this.checkPathRestrictions(request);
      if (pathDecision) return pathDecision;
    }

    return undefined;
  }

  /**
   * Stage 2 — alwaysDeny
   *
   * Returns a deny decision for requests that must always be blocked:
   *   - plan mode: any tool that is not read-only is denied
   *   - Explicit deny rules: highest-priority user-configured blocks
   */
  private async stageAlwaysDeny(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    const { request } = ctx;

    // plan mode: deny tools that are not read-only.
    if (this.mode === 'plan') {
      if (READ_ONLY_TOOLS.includes(request.toolName)) {
        // Read-only built-in tool — let stageAlwaysAllow handle the allow.
        return undefined;
      }
      if (isMetadataReadOnly(request) && !isMetadataOpenWorld(request) && !isMetadataDestructive(request)) {
        // Read-only MCP/dynamic tool — let stageAlwaysAllow handle the allow.
        return undefined;
      }
      return { behavior: 'deny', reason: 'plan mode: only read-only tools allowed' };
    }

    // Explicit deny rules take highest priority over everything below.
    if (this.matchesRules(request, this.rules.deny)) {
      return { behavior: 'deny', reason: 'matched deny rule' };
    }

    return undefined;
  }

  /**
   * Stage 3 — alwaysAllow
   *
   * Returns an allow decision for requests that should always be permitted:
   *   - bypassPermissions mode: skip all checks
   *   - plan mode: read-only tools and read-only MCP tools are allowed
   *   - Explicit allow rules: pre-approved by the user
   */
  private async stageAlwaysAllow(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    const { request } = ctx;

    // bypassPermissions: skip all further checks.
    if (this.mode === 'bypassPermissions') {
      return { behavior: 'allow', reason: 'bypass mode' };
    }

    // plan mode: allow read-only tools that weren't denied by stageAlwaysDeny.
    if (this.mode === 'plan') {
      if (READ_ONLY_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'read-only in plan mode' };
      }
      if (isMetadataReadOnly(request) && !isMetadataOpenWorld(request) && !isMetadataDestructive(request)) {
        return { behavior: 'allow', reason: `${dynamicReadOnlyReason(request)} in plan mode` };
      }
      // Non-read-only in plan mode was already denied by stageAlwaysDeny;
      // nothing more to allow here.
      return undefined;
    }

    // Explicit allow rules.
    if (this.matchesRules(request, this.rules.allow)) {
      return { behavior: 'allow', reason: 'matched allow rule' };
    }

    return undefined;
  }

  /**
   * Stage 4 — preToolUseHooks
   *
   * Executes registered PreToolUse hooks via the hookExecutor (if set).
   * A hook result of "approve" short-circuits to allow; "block" or
   * continue=false short-circuits to deny. Any other result (or an error)
   * passes through to the next stage.
   */
  private async stagePreToolUseHooks(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    if (!this.hookExecutor) return undefined;

    try {
      const hookResult = await this.hookExecutor.run('PreToolUse', {
        session_id: this.sessionId ?? '',
        transcript_path: '',
        cwd: this.cwd ?? process.cwd(),
        hook_event_name: 'PreToolUse',
        tool_name: ctx.request.toolName,
        tool_input: ctx.request.input,
        tool_use_id: ctx.request.toolUseId ?? '',
      });

      if (hookResult?.decision === 'approve') {
        return { behavior: 'allow', reason: 'PreToolUse hook approved' };
      }
      if (hookResult?.decision === 'block' || hookResult?.continue === false) {
        return { behavior: 'deny', reason: hookResult?.stopReason ?? 'PreToolUse hook blocked' };
      }
    } catch {
      // Hook execution failure — pass through
    }

    return undefined;
  }

  /**
   * Attach a hook executor to the engine. The executor's `run` method is
   * called during stagePreToolUseHooks with the event name and tool context.
   */
  setHookExecutor(executor: { run(event: string, input: unknown): Promise<any> }): void {
    this.hookExecutor = executor;
  }

  /**
   * Attach an LLM provider for the classifier stage. When set (and the
   * TRANSCRIPT_CLASSIFIER feature flag is on), the classifier will fall
   * through to the model after the rule-based checks.
   */
  setLLMProvider(provider: LLMClassifierProvider): void {
    this.llmProvider = provider;
  }

  /**
   * Stage 5 — classifier
   *
   * Claude Code-aligned classifier:
   *   1. Safe-tool whitelist → instant auto-approve (no LLM)
   *   2. readOnly annotation → auto-approve
   *   3. LLM classifier → full safety evaluation with transcript context
   *
   * This stage is feature-gated via the TRANSCRIPT_CLASSIFIER flag (default true).
   * The classifier can short-circuit to either allow or deny based on the LLM
   * decision; denies from rule-based stages remain the responsibility of
   * stageAlwaysDeny.
   */
  private async stageClassifier(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    if (!feature('TRANSCRIPT_CLASSIFIER')) return undefined;

    const decision = await classifyPermissionRequest(ctx.request, {
      recentUserMessages: this.recentUserMessages,
      allowedPrompts: this.getAllowedPrompts(),
      llmProvider: this.llmProvider,
    } satisfies ClassifierContext);

    if (decision?.approved === true) {
      return { behavior: 'allow', reason: `classifier: ${decision.rationale}` };
    }
    if (decision?.approved === false) {
      return { behavior: 'deny', reason: `classifier: ${decision.rationale}` };
    }
    return undefined;
  }

  /**
   * Stage 6 — prompt
   *
   * The final decision stage — always returns a PermissionDecision so the
   * pipeline never falls through. Handles:
   *   - Explicit ask rules
   *   - acceptEdits mode: auto-allow file-editing tools
   *   - dontAsk mode: deny anything not pre-approved by earlier stages
   *   - default / acceptEdits mode heuristics: safe tools, Bash classification,
   *     metadata-based allow/ask, and a catch-all ask
   */
  private async stagePrompt(ctx: PipelineContext): Promise<PermissionDecision | undefined> {
    const { request } = ctx;

    // Explicit ask rules.
    if (this.matchesRules(request, this.rules.ask)) {
      return { behavior: 'ask', reason: 'matched ask rule' };
    }

    // acceptEdits: auto-allow file editing tools.
    if (this.mode === 'acceptEdits') {
      if (EDIT_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'acceptEdits mode' };
      }
    }

    // dontAsk: deny anything that was not pre-approved above.
    if (this.mode === 'dontAsk') {
      return { behavior: 'deny', reason: 'not pre-approved in dontAsk mode' };
    }

    // default / acceptEdits mode heuristics.
    if (this.mode === 'default' || this.mode === 'acceptEdits') {
      // Always-safe tools need no confirmation.
      if (SAFE_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'safe tool' };
      }

      if (isMetadataDestructive(request)) {
        return { behavior: 'ask', reason: 'destructive tool requires approval' };
      }

      if (isMetadataOpenWorld(request)) {
        return { behavior: 'ask', reason: 'open-world tool requires approval' };
      }

      if (isMetadataReadOnly(request)) {
        return { behavior: 'allow', reason: dynamicReadOnlyReason(request) };
      }

      // Bash commands are audited for destructive patterns.
      if (request.toolName === 'Bash') {
        const cmd = String((request.input as Record<string, unknown>)?.command ?? '');
        const disableSandbox = Boolean((request.input as Record<string, unknown>)?.dangerouslyDisableSandbox);
        if (disableSandbox) {
          return {
            behavior: 'ask',
            reason: 'sandbox bypass requires explicit approval',
          };
        }

        // Reuse the classification cached in stageValidateInput when available
        // to avoid re-running all regex patterns on the same command string.
        const classification: BashRiskClassification =
          (ctx as any).bashClassification ?? classifyBashCommand(cmd);
        if (classification.level === 'destructive') {
          return {
            behavior: 'ask',
            reason: `destructive bash command (${classification.reason})`,
          };
        }
        if (classification.level === 'system') {
          return {
            behavior: 'ask',
            reason: `system-level bash command (${classification.reason})`,
          };
        }
        if (classification.level === 'network-pipe') {
          return {
            behavior: 'ask',
            reason: `network piping command requires approval (${classification.reason})`,
          };
        }

        if (this.mode === 'default') {
          if (classification.level === 'read-only') {
            return {
              behavior: 'allow',
              reason: `read-only bash command (${classification.reason})`,
            };
          }
          return {
            behavior: 'ask',
            reason: `bash command requires approval (${classification.level}: ${classification.reason})`,
          };
        }

        // In acceptEdits mode, local workspace commands are allowed automatically.
        if (this.mode === 'acceptEdits') {
          if (classification.level === 'network') {
            return {
              behavior: 'ask',
              reason: `networked bash command requires approval (${classification.reason})`,
            };
          }
          if (classification.level === 'unknown') {
            return {
              behavior: 'ask',
              reason: `unclassified bash command requires approval (${classification.reason})`,
            };
          }
          return {
            behavior: 'allow',
            reason: `acceptEdits mode: ${classification.level} bash`,
          };
        }
      }

      // Write/Edit/other tools need user confirmation in default mode.
      return { behavior: 'ask', reason: 'requires approval in default mode' };
    }

    // Fallback: ask (catches any future modes not yet handled above).
    return { behavior: 'ask' };
  }

  /**
   * Check whether a request matches any rule in the given list.
   *
   * Matching semantics:
   *   - toolName '*'        → matches every tool
   *   - no ruleContent      → tool name match alone is sufficient
   *   - Bash tool           → ruleContent matched as command prefix or regex
   *   - file tools          → ruleContent matched as path prefix or substring
   */
  private matchesRules(request: PermissionRequest, rules: PermissionRule[]): boolean {
    return rules.some(rule => {
      // Wildcard or exact tool name check
      if (rule.toolName !== '*' && rule.toolName !== request.toolName) {
        return false;
      }

      // No content restriction — tool name alone is enough
      if (!rule.ruleContent) {
        return true;
      }

      if (request.toolName === 'Bash') {
        const cmd = String((request.input as Record<string, unknown>)?.command ?? '');
        const classification = classifyBashCommand(cmd);
        if (rule.ruleContent.startsWith('risk:')) {
          return classification.level === rule.ruleContent.slice('risk:'.length);
        }
        if (rule.ruleContent.startsWith('category:')) {
          return classification.categories.includes(rule.ruleContent.slice('category:'.length));
        }
        return this.matchesStringPattern(cmd, rule.ruleContent);
      }

      if (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(request.toolName)) {
        // file_path for Read/Write/Edit/NotebookEdit, path for Glob/Grep (directory being accessed)
        const inp = request.input as Record<string, unknown>;
        const filePath = String(
          inp?.file_path ?? inp?.notebook_path ?? inp?.path ?? ''
        );
        return filePath.startsWith(rule.ruleContent) || filePath.includes(rule.ruleContent);
      }

      return false;
    });
  }

  /**
   * Test whether `value` matches a glob-style `pattern`.
   *
   * Glob semantics:
   *   `*`  — matches any sequence of characters (including none)
   *   `?`  — matches exactly one character
   *
   * Patterns that contain neither `*` nor `?` are treated as plain prefixes
   * so that existing rules like `"git status"` continue to work unchanged.
   */
  private matchesGlobPattern(value: string, pattern: string): boolean {
    // No wildcards — use cheap prefix check only (no substring fallback to
    // prevent patterns like "git *" from matching mid-command occurrences).
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return value.startsWith(pattern);
    }
    // Translate glob wildcards to a fully-anchored regex so that the pattern
    // must match the ENTIRE value, not just a substring of it.
    // e.g. "git *" → /^git .*$/i matches "git push origin main" but NOT
    // "echo git status && rm -rf /" which does not start with "git ".
    const regexSource = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape all regex meta-chars
      .replace(/\*/g, '.*')                   // * → any sequence
      .replace(/\?/g, '.');                   // ? → any single character
    try {
      return new RegExp(`^${regexSource}$`, 'i').test(value);
    } catch {
      return value.startsWith(pattern);
    }
  }

  /**
   * Try ruleContent first as a glob pattern (anchored when wildcards are
   * present, prefix-only when there are no wildcards), then as a raw RegExp
   * for backward compatibility with patterns that use regex syntax without
   * glob wildcards (e.g. "python:*" where * is a regex quantifier).
   *
   * IMPORTANT: The raw RegExp fallback is ONLY applied when the pattern
   * contains no glob wildcard characters (* or ?).  Patterns with wildcards
   * are handled exclusively by the anchored glob pass to prevent unanchored
   * substring matches from bypassing allow/deny rules.
   * Invalid regexes return false.
   */
  private matchesStringPattern(value: string, pattern: string): boolean {
    if (this.matchesGlobPattern(value, pattern)) {
      return true;
    }
    // Raw RegExp fallback is only safe when there are no glob wildcards.
    // If the pattern contains * or ?, the anchored glob pass is authoritative
    // and we must NOT fall through to an unanchored regex interpretation.
    if (pattern.includes('*') || pattern.includes('?')) {
      return false;
    }
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  }

  // ── Dynamic rule management ─────────────────────────────────────────────────

  addRule(behavior: PermissionBehavior, rule: PermissionRule): void {
    if (behavior === 'allow' && this.shouldSuspendDangerousAllowRules() && isDangerousClassifierAllowRule(rule)) {
      this.suspendedAllowRules = this.deduplicateRules([...this.suspendedAllowRules, rule]);
      return;
    }
    this.rules[behavior].push(rule);
    if (behavior === 'allow') {
      this.rules.allow = this.deduplicateRules(this.rules.allow);
    }
  }

  removeRule(behavior: PermissionBehavior, rule: PermissionRule): void {
    const key = normalizeRuleKey(rule);
    const list = this.rules[behavior].filter((entry) => normalizeRuleKey(entry) !== key);
    this.rules[behavior] = list;
    if (behavior === 'allow') {
      this.suspendedAllowRules = this.suspendedAllowRules.filter((entry) => normalizeRuleKey(entry) !== key);
    }
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.reconcileDangerousAllowRulesForMode();
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * Push a new mode onto the mode stack, making it the active mode.
   * Use `popMode()` to restore the previous mode (e.g. when exiting plan mode).
   */
  pushMode(newMode: PermissionMode): void {
    this.modeStack.push(this.mode);
    this.mode = newMode;
    this.reconcileDangerousAllowRulesForMode();
  }

  /**
   * Pop the top of the mode stack, restoring the previous mode.
   * If the stack is empty, this is a no-op.
   */
  popMode(): void {
    const prev = this.modeStack.pop();
    if (prev !== undefined) {
      this.mode = prev;
      this.reconcileDangerousAllowRulesForMode();
    }
  }

  getSandboxConfig(): SandboxConfig {
    return this.sandbox;
  }

  /**
   * Return a human-readable summary of the current permission configuration.
   * Used by the /permissions slash command.
   */
  getSummary(): {
    mode: PermissionMode;
    allowRules: PermissionRule[];
    suspendedAllowRules: PermissionRule[];
    denyRules: PermissionRule[];
    askRules: PermissionRule[];
    allowedPaths: string[];
    deniedPaths: string[];
  } {
    return {
      mode: this.mode,
      allowRules: [...this.rules.allow],
      suspendedAllowRules: [...this.suspendedAllowRules],
      denyRules: [...this.rules.deny],
      askRules: [...this.rules.ask],
      allowedPaths: [...this.allowedPaths],
      deniedPaths: [...this.deniedPaths],
    };
  }

  setAllowedPaths(paths: string[]): void {
    this.allowedPaths = paths;
  }

  setDeniedPaths(paths: string[]): void {
    this.deniedPaths = paths;
  }

  setSandboxConfig(sandbox: SandboxConfig): void {
    this.sandbox = { ...sandbox };
  }

  setPermissionPromptToolName(name: string): void {
    this._permissionPromptToolName = name;
  }

  /**
   * Return the MCP tool name that should be called when a permission decision
   * requires human input.
   *
   * Architectural note: `evaluate()` intentionally does NOT call this tool
   * directly — it only returns a `{ behavior: 'ask' }` decision.  The actual
   * routing to the MCP permission-prompt tool is the responsibility of the
   * caller (ConversationLoop / query.ts), which reads this value via
   * `getPermissionPromptToolName()` and dispatches the MCP call before
   * resuming execution.  Keeping routing out of PermissionEngine ensures the
   * engine remains synchronous and testable in isolation.
   */
  getPermissionPromptToolName(): string | undefined {
    return this._permissionPromptToolName;
  }

  /** Register a batch of semantic permissions. Called by ExitPlanModeV2. */
  registerAllowedPrompts(prompts: Array<{ tool: string; prompt: string }>): void {
    for (const entry of prompts) {
      if (entry.tool && entry.prompt) {
        this.allowedPrompts.push({ tool: entry.tool, prompt: entry.prompt });
      }
    }
  }

  /** Get current allowed prompts (for classifier + testing). Returns a shallow copy so callers cannot mutate internal state. */
  getAllowedPrompts(): ReadonlyArray<{ tool: string; prompt: string }> {
    return [...this.allowedPrompts];
  }

  /** Clear all registered allowed prompts. Called when re-entering plan mode. */
  clearAllowedPrompts(): void {
    this.allowedPrompts = [];
  }

  /** Set the transcript context for the classifier. Called by ConversationLoop after user turn. */
  setRecentUserMessages(messages: string[]): void {
    this.recentUserMessages = messages.slice(-10);
  }

  /**
   * Load permission rules from a settings object.
   * Typically called with the parsed settings.json content.
   *
   * Expected shape:
   * ```json
   * {
   *   "permissions": {
   *     "allow": [{ "toolName": "Read" }, { "toolName": "Bash", "ruleContent": "ls *" }],
   *     "deny":  [{ "toolName": "Bash", "ruleContent": "rm -rf *" }],
   *     "ask":   [{ "toolName": "Write" }]
   *   }
   * }
   * ```
   */
  loadFromSettings(settings: Record<string, any>): void {
    if (settings.sandbox && typeof settings.sandbox === 'object' && typeof settings.sandbox.enabled === 'boolean') {
      this.setSandboxConfig(settings.sandbox as SandboxConfig);
    }

    const perms = settings.permissions;
    if (!perms) {
      this.reconcileDangerousAllowRulesForMode();
      return;
    }

    for (const rule of (perms.allow ?? []) as PermissionRule[]) {
      this.addRule('allow', rule);
    }
    for (const rule of (perms.deny ?? []) as PermissionRule[]) {
      this.addRule('deny', rule);
    }
    for (const rule of (perms.ask ?? []) as PermissionRule[]) {
      this.addRule('ask', rule);
    }
    if (Array.isArray(perms.allowedPaths)) {
      this.setAllowedPaths(perms.allowedPaths.filter((p: unknown): p is string => typeof p === 'string'));
    }
    if (Array.isArray(perms.deniedPaths)) {
      this.setDeniedPaths(perms.deniedPaths.filter((p: unknown): p is string => typeof p === 'string'));
    }
    this.reconcileDangerousAllowRulesForMode();
  }

  replaceFromSettings(settings: Record<string, any> | null | undefined): void {
    this.rules = {
      allow: [],
      deny: [],
      ask: [],
    };
    this.suspendedAllowRules = [];
    this.allowedPaths = [];
    this.deniedPaths = [];
    this.sandbox = { enabled: false };
    if (settings) {
      this.loadFromSettings(settings);
    } else {
      this.reconcileDangerousAllowRulesForMode();
    }
  }

  private shouldSuspendDangerousAllowRules(): boolean {
    return this.mode === 'acceptEdits' || this.mode === 'plan';
  }

  private deduplicateRules(rules: PermissionRule[]): PermissionRule[] {
    const seen = new Set<string>();
    const deduped: PermissionRule[] = [];
    for (const rule of rules) {
      const key = normalizeRuleKey(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(rule);
    }
    return deduped;
  }

  private reconcileDangerousAllowRulesForMode(): void {
    if (this.shouldSuspendDangerousAllowRules()) {
      const kept: PermissionRule[] = [];
      const suspended = [...this.suspendedAllowRules];
      for (const rule of this.rules.allow) {
        if (isDangerousClassifierAllowRule(rule)) {
          suspended.push(rule);
        } else {
          kept.push(rule);
        }
      }
      this.rules.allow = this.deduplicateRules(kept);
      this.suspendedAllowRules = this.deduplicateRules(suspended);
      return;
    }

    if (this.suspendedAllowRules.length === 0) {
      return;
    }
    this.rules.allow = this.deduplicateRules([...this.rules.allow, ...this.suspendedAllowRules]);
    this.suspendedAllowRules = [];
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Check sandbox restrictions — filesystem write paths and read deny lists.
   * Returns a PermissionDecision if the request is affected, or null.
   */
  private checkSandbox(request: PermissionRequest): PermissionDecision | null {
    const fs = this.sandbox.filesystem;
    const inp = request.input as Record<string, unknown>;
    const filePath = String(inp?.file_path ?? inp?.path ?? inp?.notebook_path ?? '');

    // Sandbox: deny reads for blocked paths
    if (filePath && fs?.denyRead) {
      for (const denied of fs.denyRead) {
        if (filePath.startsWith(denied)) {
          return { behavior: 'deny', reason: `sandbox: read denied for ${denied}` };
        }
      }
    }

    // Sandbox: restrict writes to allowed paths only
    const isWriteTool = ['Write', 'Edit', 'NotebookEdit'].includes(request.toolName);
    if (isWriteTool && filePath && fs?.allowWrite && fs.allowWrite.length > 0) {
      const inAllowed = fs.allowWrite.some(a => filePath.startsWith(a));
      if (!inAllowed) {
        return { behavior: 'deny', reason: `sandbox: write outside allowed paths` };
      }
    }

    // Sandbox: deny writes to explicitly denied paths
    if (isWriteTool && filePath && fs?.denyWrite) {
      for (const denied of fs.denyWrite) {
        if (filePath.startsWith(denied)) {
          return { behavior: 'deny', reason: `sandbox: write denied for ${denied}` };
        }
      }
    }

    // Sandbox: auto-allow only non-destructive Bash if explicitly enabled.
    if (this.sandbox.autoAllowBashIfSandboxed && request.toolName === 'Bash') {
      if (Array.isArray(fs?.denyRead) && fs.denyRead.length > 0) {
        return null;
      }
      const cmd = String((inp?.command ?? ''));
      const classification = classifyBashCommand(cmd);
      if (classification.level === 'read-only' || classification.level === 'workspace-write') {
        return {
          behavior: 'allow',
          reason: `sandbox: auto-allow ${classification.level} bash (${classification.reason})`,
        };
      }
    }

    return null;
  }

  /**
   * Check whether a file-system tool request is blocked by path restrictions.
   * Returns a PermissionDecision if the request should be denied, or null to
   * continue normal evaluation.
   *
   * Priority:
   *   1. deniedPaths — always deny if the path starts with any denied prefix
   *   2. allowedPaths — deny if allowedPaths is non-empty and path is outside all of them
   */
  private checkPathRestrictions(request: PermissionRequest): PermissionDecision | null {
    const inp = request.input as Record<string, unknown>;
    // For Grep, the search directory is `path`, NOT `pattern` (which is the regex).
    // For Glob, the directory is also `path`.
    const filePath = String(
      inp?.file_path ??
      inp?.path ??
      inp?.notebook_path ??
      ''
    );

    if (!filePath) return null;

    // Denied paths take precedence
    for (const denied of this.deniedPaths) {
      if (filePath.startsWith(denied)) {
        return { behavior: 'deny', reason: `path is in denied list: ${denied}` };
      }
    }

    // If allowed paths are configured, the file must be inside at least one
    if (this.allowedPaths.length > 0) {
      const inAllowed = this.allowedPaths.some(allowed => filePath.startsWith(allowed));
      if (!inAllowed) {
        return {
          behavior: 'deny',
          reason: `path is outside allowed directories: ${this.allowedPaths.join(', ')}`,
        };
      }
    }

    return null;
  }
}
