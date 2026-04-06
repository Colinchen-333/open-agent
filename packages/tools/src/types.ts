import type { ToolAnnotations } from '@open-agent/core';
export type { ToolAnnotations };

/** Result of a pre-execution input validation check. */
export interface ValidationResult {
  valid: false;
  errorCode: string;
  errorMessage: string;
}

// Tool input types - precisely reproduced from sdk-tools.d.ts

export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export interface FileWriteInput {
  file_path: string;
  content: string;
}

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-B'?: number;
  '-A'?: number;
  '-C'?: number;
  context?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

// Tool output types

/**
 * @deprecated The bash tool now returns a plain `string` instead of BashOutput.
 * This interface is kept for backwards compatibility only and will be removed in a future version.
 */
export interface BashOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  backgroundTaskId?: string;
}

export interface GlobOutput {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export interface GrepOutput {
  mode?: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
}

export type ToolCapabilityCategory =
  | 'filesystem'
  | 'shell'
  | 'search'
  | 'web'
  | 'task'
  | 'agent'
  | 'workspace'
  | 'configuration'
  | 'skill'
  | 'planning'
  | 'mcp'
  | 'utility'
  | 'remote'
  | 'other';

export type ToolCapabilityRisk = 'low' | 'medium' | 'high';

export interface ToolCapability {
  category: ToolCapabilityCategory;
  tags?: string[];
  risk?: ToolCapabilityRisk;
  needsWorkspaceWrite?: boolean;
  concurrencySafe?: boolean;
  readOnly?: boolean;
}

export interface ResolvedToolCapability extends ToolCapability {
  source: 'explicit' | 'derived';
}

export interface ToolCapabilityExportEntry {
  name: string;
  description: string;
  capability: ResolvedToolCapability;
}

export interface ToolCapabilityManifest {
  tools: ToolCapabilityExportEntry[];
}

// Tool definition interface
export interface ToolDefinition {
  name: string;
  description: string;
  /** MCP origin metadata. Set only on tools wrapped from MCP `listTools` responses. */
  mcpInfo?: {
    serverName: string;
    /** The tool name as returned by the MCP server (without the `mcp__<server>__` prefix). */
    toolName: string;
  };
  /** When true, enables strict API parameter validation (unknown properties rejected). */
  strict?: boolean;
  /** Whether this tool was loaded from an MCP server. */
  isMcp?: boolean;
  /** Whether this tool was loaded from an LSP server. */
  isLsp?: boolean;
  inputSchema: Record<string, any>; // JSON Schema
  execute(input: any, context: ToolContext): Promise<any>;
  /** Optional short past-tense summary label used for tool_use_summary events. */
  getToolUseSummary?: (input: any, result?: unknown, isError?: boolean) => string | null;
  /** Custom timeout in milliseconds. Overrides the default 60s timeout in ConversationLoop. */
  timeout?: number;
  /** Optional JSON schema describing the structured result shape. */
  outputSchema?: Record<string, any>;
  /** Whether this tool is read-only for the given invocation. Defaults to false when omitted. */
  isReadOnly?: boolean | ((input: any) => boolean);
  /** Whether this tool may safely run in parallel with other tools. Defaults to true when omitted. */
  isConcurrencySafe?: boolean | ((input: any) => boolean);
  /** Optional capability metadata for plan, routing, and export layers. */
  capability?: ToolCapability;
  /** When true, this tool is not surfaced in the initial tool list. It must be
   *  explicitly discovered via ToolSearch. Defaults to false. */
  shouldDefer?: boolean;

  /** MCP-aligned annotations describing the behavioral nature of this tool.
   *  Used by the permission engine and rendering layer; does not change execution. */
  annotations?: ToolAnnotations;

  /** Maximum size of the tool's result in characters before truncation. Default: 100_000. */
  maxResultSizeChars?: number;

  /** How this tool reacts to user interrupt. 'cancel' = abort mid-execution,
   *  'block' = run to completion. Default: 'cancel'. */
  interruptBehavior?: 'cancel' | 'block';

  /** Extract searchable text from the tool's output for transcript search. */
  extractSearchText?: (output: unknown) => string;

  /** Returns a human-readable label for the status bar while this tool is active.
   *  Mirrors Claude Code's getActivityDescription(input) convention. */
  getActivityDescription?: (input: unknown) => string;

  /** Decide whether the result has been truncated (for UI indicators). */
  isResultTruncated?: (output: unknown) => boolean;

  /** For permission matcher pattern compilation. Returns a predicate that
   *  tests whether a pattern (e.g., "git push*") matches this input. */
  preparePermissionMatcher?: (input: unknown) => (pattern: string) => boolean;

  /** For the permission classifier — categorize the action. */
  isSearchOrReadCommand?: (input: unknown) => { isSearch: boolean; isRead: boolean; isList: boolean };

  /** Mutates input in-place to add derived fields for observability (e.g., resolved paths). */
  backfillObservableInput?: (input: unknown) => void;

  /** Render helpers (string output for terminal renderer; ink renderer can overlay React). */
  renderToolUseMessage?: (input: unknown) => string;
  renderToolResultMessage?: (output: unknown) => string;
  renderToolUseErrorMessage?: (error: unknown) => string;

  /** Dynamic description generator. When present, overrides the static `description` field.
   *  Receives optional context for content-aware descriptions. */
  dynamicDescription?: (context?: {
    isNonInteractive?: boolean;
    permissionMode?: string;
    cwd?: string;
  }) => string;

  /** System prompt section for this tool. Injected into the system prompt
   *  alongside the tool schema when the tool is active. */
  prompt?: (context?: {
    permissionMode?: string;
    cwd?: string;
    tools?: string[];
  }) => string;

  /** Search hint for ToolSearch matching (freeform keywords). */
  searchHint?: string;

  /** Alternative names for tool lookup (e.g., ['FileRead'] for 'Read'). */
  aliases?: string[];

  /** When true, include in turn-1 tool list even if shouldDefer is true.
   *  Used for tools that are deferred for ToolSearch but still need to be
   *  available from the first turn. */
  alwaysLoad?: boolean;

  /** Whether this tool performs destructive/irreversible operations for the given input.
   *  Used by the permission engine and UI for extra confirmation. */
  isDestructive?: boolean | ((input: unknown) => boolean);

  /** Whether this tool operates on untrusted/external content.
   *  Affects permission classification and sandbox policy. */
  isOpenWorld?: boolean | ((input: unknown) => boolean);

  /** Whether this tool is currently enabled (feature gate). When false, excluded from tool list. */
  isEnabled?: boolean | (() => boolean);

  /** Convert tool input to a string for the auto-permission classifier.
   *  Default: `${toolName} ${JSON.stringify(input).slice(0,200)}` */
  toAutoClassifierInput?: (input: unknown) => string;

  /** Extract the primary file path from tool input for permission rule matching. */
  getPath?: (input: unknown) => string | null;

  /** Check if two tool inputs are semantically equivalent (for deduplication). */
  inputsEquivalent?: (a: unknown, b: unknown) => boolean;

  /** Dynamic user-facing name based on input. Defaults to `name` when omitted. */
  userFacingName?: (input: unknown) => string;

  /** Per-tool permission check that runs before the engine pipeline.
   *  Return 'allow' | 'deny' | 'ask'. If 'deny', the tool call is blocked
   *  without reaching the engine. If 'allow', skips engine (fast path). */
  checkPermissions?: (input: unknown) => 'allow' | 'deny' | 'ask';

  /** Pre-execution input validation. Runs before permissions.
   *  Return null/undefined for valid input, or a ValidationResult with error. */
  validateInput?: (input: unknown, context: ToolContext) => ValidationResult | null | undefined;

  /** Convert tool output to Anthropic SDK ToolResultBlockParam format.
   *  Default behavior (when omitted): { type: 'tool_result', tool_use_id, content: String(output) } */
  mapToolResultToToolResultBlockParam?: (output: unknown, toolUseId: string) => {
    type: 'tool_result';
    tool_use_id: string;
    content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: string; data: string; media_type: string } }>;
    is_error?: boolean;
  };
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId: string;
  /** The tool_use_id of the current tool call (set by ConversationLoop). */
  toolUseId?: string;
  /**
   * Tracks which files have been read in this conversation.
   * Edit/Write tools use this to enforce "read before edit" safety.
   */
  fileReadTracker?: FileReadTracker;
  /** Reactive state store getter — provided when a store is wired in. */
  getAppState?: () => any;
  /** Reactive state store updater — provided when a store is wired in. */
  setAppState?: (updater: (prev: any) => any) => void;
  /**
   * Marks a deferred tool as activated so ConversationLoop includes it in
   * subsequent turns' tool lists.  Provided by ConversationLoop; may be absent
   * in lightweight test contexts.
   */
  activateDeferredTool?: (name: string) => void;
}

/**
 * Tracks files that have been read so that Edit can enforce the
 * "you must read a file before editing it" safety check.
 */
export interface FileReadTracker {
  /** Mark a file as having been read. */
  markRead(filePath: string): void;
  /** Check if a file has been read in this conversation. */
  hasBeenRead(filePath: string): boolean;
}
