import type { PermissionDecision, PermissionRequest } from './types';

export type PipelineStage =
  | 'validateInput'
  | 'alwaysDeny'
  | 'alwaysAllow'
  | 'preToolUseHooks'
  | 'classifier'
  | 'prompt';

export interface PipelineContext {
  request: PermissionRequest;
  trace?: (stage: PipelineStage) => void;
}

export type StageHandler = (
  ctx: PipelineContext,
) => Promise<PermissionDecision | undefined>;

/**
 * Run a sequence of pipeline stages in order.
 *
 * Each stage is called with the shared context. If a stage returns a
 * PermissionDecision the pipeline short-circuits and returns that result
 * immediately. If a stage returns undefined the next stage is tried.
 *
 * The trace callback (if present) is called before each stage handler,
 * allowing tests to observe the execution order for observability.
 *
 * Throws if no stage resolves — the final `prompt` stage must always return
 * a decision so this should never be reached in practice.
 */
export async function runPipeline(
  ctx: PipelineContext,
  stages: Array<[PipelineStage, StageHandler]>,
): Promise<PermissionDecision> {
  for (const [name, handler] of stages) {
    ctx.trace?.(name);
    const result = await handler(ctx);
    if (result) return result;
  }
  // Fallthrough should not happen if `prompt` always returns a decision.
  throw new Error('Permission pipeline did not resolve');
}
