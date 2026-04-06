/**
 * Complete SDK type parity with Claude Code Agent SDK.
 * These types close the remaining ~20 type gaps.
 *
 * NOTE: Types that already exist in ./types.ts or @open-agent/core are
 * intentionally omitted to avoid duplicate-identifier errors:
 *   - PermissionUpdateDestination  (./types.ts — different union values)
 *   - RewindFilesResult            (./types.ts)
 *   - AgentInfo                    (./types.ts)
 *   - ModelInfo                    (@open-agent/core)
 *   - AccountInfo                  (@open-agent/core)
 *   - Settings                     (@open-agent/core via config-loader)
 *   - ExitReason                   (@open-agent/core)
 *   - ThinkingConfig               (@open-agent/core — already covers adaptive)
 */

// ── Permission types ──

export type PermissionDecisionClassification =
  | 'auto_approved_safe_tool'
  | 'auto_approved_annotation'
  | 'auto_approved_classifier'
  | 'auto_approved_rule'
  | 'blocked_classifier'
  | 'blocked_rule'
  | 'user_approved'
  | 'user_denied';

/**
 * Claude Code SDK uses `'session' | 'project' | 'user'` for permission
 * update destinations.  Our existing PermissionUpdateDestination in types.ts
 * uses finer-grained values (`userSettings`, `projectSettings`, etc.).
 * This alias bridges the gap for consumers expecting the Claude Code shape.
 */
export type PermissionUpdateTarget = 'session' | 'project' | 'user';

// ── Thinking types ──

export interface ThinkingAdaptive {
  type: 'adaptive';
  /** Budget range the model can use */
  budgetTokens?: number;
}

// ── Output format types ──

export interface BaseOutputFormat {
  type: 'text' | 'json' | 'stream-json';
}

export interface JsonSchemaOutputFormat {
  type: 'json_schema';
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export type OutputFormat = BaseOutputFormat | JsonSchemaOutputFormat;

// ── Prompt types ──

export interface PromptRequestOption {
  label: string;
  value: string;
}

export interface PromptRequest {
  id: string;
  message: string;
  options?: PromptRequestOption[];
  defaultValue?: string;
  type: 'text' | 'confirm' | 'select';
}

export interface PromptResponse {
  id: string;
  value: string;
  cancelled: boolean;
}

// ── Sandbox types ──

export interface SandboxIgnoreViolations {
  /** Patterns to ignore in sandbox violation reports */
  patterns?: string[];
  /** Whether to ignore all violations */
  ignoreAll?: boolean;
}

// ── Runtime types ──

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export type FastModeState = 'enabled' | 'disabled' | 'auto';

export type SdkBeta = string; // Beta feature flag identifier

export interface SdkPluginConfig {
  name: string;
  path: string;
  enabled?: boolean;
}

// ── Cron/Daemon types ──

export interface CronTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring?: boolean;
}

export interface CronJitterConfig {
  recurringFrac: number;
  recurringCapMs: number;
  oneShotMaxMs: number;
  oneShotFloorMs: number;
  oneShotMinuteMod: number;
  recurringMaxAgeMs: number;
}

export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] };

export interface ScheduledTasksHandle {
  events(): AsyncGenerator<ScheduledTaskEvent>;
  getNextFireTime(): number | null;
}

// ── Remote control types ──

export interface InboundPrompt {
  content: string | unknown[];
  uuid?: string;
}

export interface ConnectRemoteControlOptions {
  dir: string;
  name?: string;
  workerType?: string;
  branch?: string;
  gitRepoUrl?: string | null;
  getAccessToken: () => string | undefined;
  baseUrl: string;
  orgUUID: string;
  model: string;
}

export interface RemoteControlHandle {
  sessionUrl: string;
  environmentId: string;
  bridgeSessionId: string;
  write(msg: unknown): void;
  sendResult(): void;
  sendControlRequest(req: unknown): void;
  sendControlResponse(res: unknown): void;
  sendControlCancelRequest(requestId: string): void;
  inboundPrompts(): AsyncGenerator<InboundPrompt>;
  controlRequests(): AsyncGenerator<unknown>;
  permissionResponses(): AsyncGenerator<unknown>;
  onStateChange(cb: (state: 'ready' | 'connected' | 'reconnecting' | 'failed', detail?: string) => void): void;
  teardown(): Promise<void>;
}

// ── Slash command type ──

export interface SlashCommandInfo {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  category?: string;
}
