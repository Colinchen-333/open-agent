import type { PermissionMode, PermissionBehavior } from '@open-agent/core';
import type {
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
  SandboxConfig,
} from './types';

// Read-only tools that are always safe for informational access
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// Tools allowed automatically in acceptEdits mode
const EDIT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// Tools that are always safe regardless of mode (never destructive)
const SAFE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'];

// Patterns that indicate a potentially destructive or privileged command.
// Matches Claude Code's dangerous command detection list.
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-rf?|-r\s+-f|-f\s+-r|--recursive)\b/,
  /\bgit\s+push(\s+--force|-f)\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+\.\b/,
  /\bgit\s+clean\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  />\s*\/dev\//,
  // Output redirection to a file (> or >>) — can overwrite important files
  /[^>]>{1,2}\s*\S/,
  /\bcurl\b.*\|\s*bash\b/,
  /\bwget\b.*\|\s*bash\b/,
];

// File-system tools that operate on paths — subject to allowedPaths/deniedPaths checks
const FILE_SYSTEM_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

export class PermissionEngine {
  private mode: PermissionMode;
  private rules: {
    allow: PermissionRule[];
    deny: PermissionRule[];
    ask: PermissionRule[];
  };
  private sandbox: SandboxConfig;
  private allowedPaths: string[];
  private deniedPaths: string[];

  constructor(config?: Partial<PermissionConfig & { sandbox: SandboxConfig }>) {
    this.mode = config?.mode ?? 'default';
    this.rules = {
      allow: config?.allowRules ?? [],
      deny: config?.denyRules ?? [],
      ask: config?.askRules ?? [],
    };
    this.sandbox = config?.sandbox ?? { enabled: false };
    this.allowedPaths = config?.allowedPaths ?? [];
    this.deniedPaths = config?.deniedPaths ?? [];
  }

  /**
   * Evaluate a permission request and return the decision.
   *
   * Evaluation order:
   *   1. bypassPermissions mode  → always allow
   *   2. plan mode               → only read-only tools allowed
   *   3. deny rules              → highest priority, always deny on match
   *   4. allow rules             → explicitly pre-approved
   *   5. ask rules               → explicitly requires confirmation
   *   6. acceptEdits mode        → auto-allow file edit tools
   *   7. dontAsk mode            → deny anything not pre-approved above
   *   8. default mode            → allow safe tools; ask for dangerous/write tools
   */
  evaluate(request: PermissionRequest): PermissionDecision {
    // 1. bypassPermissions: skip all checks
    if (this.mode === 'bypassPermissions') {
      return { behavior: 'allow', reason: 'bypass mode' };
    }

    // 1b. Sandbox enforcement — file system + auto-allow bash if sandboxed.
    if (this.sandbox.enabled) {
      const sandboxDecision = this.checkSandbox(request);
      if (sandboxDecision) return sandboxDecision;
    }

    // 1c. File system path restrictions — checked after bypassPermissions but
    //     before all other rules so they can't be bypassed by allow rules.
    if (FILE_SYSTEM_TOOLS.includes(request.toolName)) {
      const pathDecision = this.checkPathRestrictions(request);
      if (pathDecision) return pathDecision;
    }

    // 2. plan mode: only read-only tools permitted
    if (this.mode === 'plan') {
      if (READ_ONLY_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'read-only in plan mode' };
      }
      return { behavior: 'deny', reason: 'plan mode: only read-only tools allowed' };
    }

    // 3. Deny rules take highest priority over everything below
    if (this.matchesRules(request, this.rules.deny)) {
      return { behavior: 'deny', reason: 'matched deny rule' };
    }

    // 4. Explicit allow rules
    if (this.matchesRules(request, this.rules.allow)) {
      return { behavior: 'allow', reason: 'matched allow rule' };
    }

    // 5. Explicit ask rules
    if (this.matchesRules(request, this.rules.ask)) {
      return { behavior: 'ask', reason: 'matched ask rule' };
    }

    // 6. acceptEdits: auto-allow file editing tools
    if (this.mode === 'acceptEdits') {
      if (EDIT_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'acceptEdits mode' };
      }
    }

    // 7. dontAsk: deny anything that was not pre-approved above
    if (this.mode === 'dontAsk') {
      return { behavior: 'deny', reason: 'not pre-approved in dontAsk mode' };
    }

    // 8. default mode heuristics
    if (this.mode === 'default' || this.mode === 'acceptEdits') {
      // Always-safe tools need no confirmation
      if (SAFE_TOOLS.includes(request.toolName)) {
        return { behavior: 'allow', reason: 'safe tool' };
      }

      // Bash commands are audited for destructive patterns
      if (request.toolName === 'Bash') {
        const cmd = String((request.input as Record<string, unknown>)?.command ?? '');
        if (this.isDangerousCommand(cmd)) {
          return {
            behavior: 'ask',
            reason: `potentially dangerous command: ${cmd.slice(0, 100)}`,
          };
        }
        // In acceptEdits mode, non-dangerous Bash is allowed automatically
        if (this.mode === 'acceptEdits') {
          return { behavior: 'allow', reason: 'acceptEdits mode: non-dangerous bash' };
        }
        // In default mode, ask before running any Bash command
        return { behavior: 'ask', reason: 'requires approval in default mode' };
      }

      // Write/Edit/other tools need user confirmation in default mode
      return { behavior: 'ask', reason: 'requires approval in default mode' };
    }

    // Fallback: ask
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
        return this.matchesStringPattern(cmd, rule.ruleContent);
      }

      if (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(request.toolName)) {
        // Support both file_path (Read/Write/Edit) and pattern (Glob/Grep)
        const filePath = String(
          (request.input as Record<string, unknown>)?.file_path ??
          (request.input as Record<string, unknown>)?.pattern ??
          ''
        );
        return filePath.startsWith(rule.ruleContent) || filePath.includes(rule.ruleContent);
      }

      return false;
    });
  }

  /**
   * Try ruleContent first as a plain prefix, then as a RegExp.
   * Invalid regexes fall back to a substring test.
   */
  private matchesStringPattern(value: string, pattern: string): boolean {
    if (value.startsWith(pattern)) {
      return true;
    }
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  }

  /**
   * Return true when a Bash command matches at least one known-dangerous pattern.
   */
  private isDangerousCommand(cmd: string): boolean {
    return DANGEROUS_COMMAND_PATTERNS.some(re => re.test(cmd));
  }

  // ── Dynamic rule management ─────────────────────────────────────────────────

  addRule(behavior: PermissionBehavior, rule: PermissionRule): void {
    this.rules[behavior].push(rule);
  }

  removeRule(behavior: PermissionBehavior, rule: PermissionRule): void {
    const list = this.rules[behavior];
    const idx = list.findIndex(
      r => r.toolName === rule.toolName && r.ruleContent === rule.ruleContent
    );
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
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
    denyRules: PermissionRule[];
    askRules: PermissionRule[];
    allowedPaths: string[];
    deniedPaths: string[];
  } {
    return {
      mode: this.mode,
      allowRules: [...this.rules.allow],
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
    const perms = settings.permissions;
    if (!perms) return;

    for (const rule of (perms.allow ?? []) as PermissionRule[]) {
      this.addRule('allow', rule);
    }
    for (const rule of (perms.deny ?? []) as PermissionRule[]) {
      this.addRule('deny', rule);
    }
    for (const rule of (perms.ask ?? []) as PermissionRule[]) {
      this.addRule('ask', rule);
    }
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

    // Sandbox: auto-allow Bash if autoAllowBashIfSandboxed is set
    if (this.sandbox.autoAllowBashIfSandboxed && request.toolName === 'Bash') {
      return { behavior: 'allow', reason: 'sandbox: auto-allow bash (sandboxed)' };
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
