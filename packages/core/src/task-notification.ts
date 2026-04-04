export type TaskNotificationStatus = 'completed' | 'failed' | 'stopped';

export interface TaskOrchestrationTemplates {
  resume_prompt_template?: string;
  verification_prompt_template?: string;
  retry_prompt_template?: string;
}

function normalizeText(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function buildTaskContext(params: {
  description?: string;
  summary?: string;
  result?: string;
}): string {
  const parts = [params.description, params.summary, params.result]
    .map((value) => normalizeText(value))
    .filter((value): value is string => Boolean(value));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const fingerprint = part.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push(part);
  }

  if (deduped.length === 0) {
    return 'No additional worker context was captured.';
  }

  return truncateText(deduped.join(' | '), 320);
}

export function buildTaskOrchestrationTemplates(params: {
  taskId: string;
  status: TaskNotificationStatus;
  description?: string;
  summary?: string;
  result?: string;
}): TaskOrchestrationTemplates {
  const context = buildTaskContext(params);

  if (params.status === 'completed') {
    return {
      resume_prompt_template:
        `Continue from your existing context for task ${params.taskId}. ` +
        `Latest worker outcome: ${context}. ` +
        'Follow-up delta from the coordinator: <fill in the exact additional change>. ' +
        'Reuse prior context, avoid broad re-exploration, and verify the new delta before returning.',
      verification_prompt_template:
        `Independently verify the completed result from task ${params.taskId}. ` +
        `Baseline context: ${context}. ` +
        'Claims to verify: <fill in the exact behavior, files, or acceptance criteria>. ' +
        'Checks to run: <fill in concrete commands or inspections>. ' +
        'Pass only with direct evidence; otherwise report the precise failure or missing proof.',
    };
  }

  if (params.status === 'failed') {
    return {
      retry_prompt_template:
        `Continue from your existing context for task ${params.taskId}. ` +
        `Failure context: ${context}. ` +
        'Investigate the failure chain, test the smallest next hypothesis, and retry only the narrowest plausible fix. ' +
        'Verify before returning.',
    };
  }

  return {
    resume_prompt_template:
      `Continue from your existing context for task ${params.taskId}. ` +
      `Interrupted context: ${context}. ` +
      'First confirm what is already done versus still pending, then finish the remaining scoped work and verify it before returning.',
  };
}
