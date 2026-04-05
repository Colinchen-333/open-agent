import type { SDKTaskNotificationMessage } from './types.js';

export interface CoordinatorRecoveryHint {
  taskId: string;
  status: SDKTaskNotificationMessage['status'];
  teamName?: string;
  description?: string;
  summary?: string;
  completedAt?: string;
  resumePromptTemplate?: string;
  verificationPromptTemplate?: string;
  retryPromptTemplate?: string;
}

export interface CoordinatorContext {
  workerTools?: string[];
  activeTeam?: string;
  scratchpadDir?: string;
  canUseSkills?: boolean;
  canUseMcpTools?: boolean;
  recoveryHints?: CoordinatorRecoveryHint[];
}

export type CoordinatorTaskNotificationLike =
  Pick<SDKTaskNotificationMessage, 'task_id' | 'status'>
  & Partial<Pick<
    SDKTaskNotificationMessage,
    'team_name' | 'description' | 'summary' | 'completed_at' | 'orchestration_templates'
  >>;

export interface BuildCoordinatorContextOptions {
  workerTools?: string[];
  activeTeam?: string;
  scratchpadDir?: string;
  canUseSkills?: boolean;
  canUseMcpTools?: boolean;
  taskNotifications?: CoordinatorTaskNotificationLike[];
  maxRecoveryHints?: number;
}

const DEFAULT_MAX_RECOVERY_HINTS = 3;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildRecoveryHints(
  notifications: CoordinatorTaskNotificationLike[] | undefined,
  maxHints: number,
): CoordinatorRecoveryHint[] {
  if (!Array.isArray(notifications) || notifications.length === 0 || maxHints <= 0) {
    return [];
  }

  const hints: CoordinatorRecoveryHint[] = [];
  const seen = new Set<string>();

  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    if (hints.length >= maxHints) break;
    const notification = notifications[index];
    const taskId = normalizeOptionalString(notification?.task_id);
    const status = normalizeOptionalString(notification?.status) as SDKTaskNotificationMessage['status'] | undefined;
    if (!taskId || !status) continue;

    const completedAt = normalizeOptionalString(notification.completed_at);
    const fingerprint = `${taskId}::${status}::${completedAt ?? ''}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const resumePromptTemplate = normalizeOptionalString(notification.orchestration_templates?.resume_prompt_template);
    const verificationPromptTemplate = normalizeOptionalString(notification.orchestration_templates?.verification_prompt_template);
    const retryPromptTemplate = normalizeOptionalString(notification.orchestration_templates?.retry_prompt_template);

    hints.push({
      taskId,
      status,
      ...(normalizeOptionalString(notification.team_name) ? { teamName: normalizeOptionalString(notification.team_name) } : {}),
      ...(normalizeOptionalString(notification.description) ? { description: normalizeOptionalString(notification.description) } : {}),
      ...(normalizeOptionalString(notification.summary) ? { summary: normalizeOptionalString(notification.summary) } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(resumePromptTemplate ? { resumePromptTemplate } : {}),
      ...(verificationPromptTemplate ? { verificationPromptTemplate } : {}),
      ...(retryPromptTemplate ? { retryPromptTemplate } : {}),
    });
  }

  return hints;
}

function normalizeWorkerTools(tools: string[] | undefined): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return [...new Set(
    tools
      .map((tool) => normalizeOptionalString(tool))
      .filter((tool): tool is string => Boolean(tool)),
  )].sort();
}

export function buildCoordinatorContext(
  options: BuildCoordinatorContextOptions,
): CoordinatorContext | undefined {
  const workerTools = normalizeWorkerTools(options.workerTools);
  const activeTeam = normalizeOptionalString(options.activeTeam);
  const scratchpadDir = normalizeOptionalString(options.scratchpadDir);
  const maxRecoveryHints = Number.isInteger(options.maxRecoveryHints)
    ? Math.max(0, options.maxRecoveryHints ?? DEFAULT_MAX_RECOVERY_HINTS)
    : DEFAULT_MAX_RECOVERY_HINTS;
  const recoveryHints = buildRecoveryHints(options.taskNotifications, maxRecoveryHints);

  const context: CoordinatorContext = {
    ...(workerTools.length > 0 ? { workerTools } : {}),
    ...(activeTeam ? { activeTeam } : {}),
    ...(scratchpadDir ? { scratchpadDir } : {}),
    ...(options.canUseSkills === true ? { canUseSkills: true } : {}),
    ...(options.canUseMcpTools === true ? { canUseMcpTools: true } : {}),
    ...(recoveryHints.length > 0 ? { recoveryHints } : {}),
  };

  return Object.keys(context).length > 0 ? context : undefined;
}
