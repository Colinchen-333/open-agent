import type { PermissionRequest } from './types';
import type { ClassifierContext, ClassifierDecision } from './classifier';

export interface LLMClassifierProvider {
  classify(prompt: string): Promise<string>;
}

/**
 * LLM-backed permission classifier. Asks the model whether a specific
 * tool invocation is safe given the conversation context.
 *
 * Returns:
 *   - { approved: true }  when the model responds with APPROVE
 *   - { approved: false } when the model responds with DENY
 *   - null               on ambiguous responses or provider errors (pass-through)
 */
export function createLLMClassifier(provider: LLMClassifierProvider) {
  return async function classifyWithLLM(
    request: PermissionRequest,
    context: ClassifierContext,
  ): Promise<ClassifierDecision | null> {
    const recentContext = (context.recentUserMessages ?? []).slice(-3).join('\n');
    const toolInput =
      typeof request.input === 'string'
        ? request.input
        : JSON.stringify(request.input).slice(0, 500);

    const prompt = `You are a security classifier for a coding assistant. Determine if this tool call is safe to auto-approve.

Tool: ${request.toolName}
Input: ${toolInput}
${request.annotations?.readOnly ? 'This tool is annotated as read-only.' : ''}
${request.annotations?.destructive ? 'WARNING: This tool is annotated as destructive.' : ''}

Recent user context:
${recentContext || '(no recent context)'}

${
  context.allowedPrompts?.length
    ? `Pre-approved operations:\n${context.allowedPrompts.map((p) => `- ${p.tool}: ${p.prompt}`).join('\n')}`
    : ''
}

Respond with exactly one word: APPROVE or DENY`;

    // Use word-boundary regex so that "DISAPPROVE" does not match APPROVE,
    // and "UNDENIABLE" does not match DENY. The model is prompted to reply
    // with exactly one word, but defensive parsing prevents false positives
    // from prose responses where APPROVE or DENY appears as a substring of a
    // longer word (e.g. DISAPPROVE, UNAPPROVED, DENIABLE).
    const DENY_PATTERN = /\bDENY\b/i;
    const APPROVE_PATTERN = /\bAPPROVE\b/i;

    try {
      const response = await provider.classify(prompt);
      const normalized = response.trim();

      // Check DENY first to avoid "DENY. Do not approve." being matched as APPROVE.
      if (DENY_PATTERN.test(normalized)) {
        return { approved: false, rationale: `LLM classifier denied: ${request.toolName}` };
      }
      if (APPROVE_PATTERN.test(normalized)) {
        return { approved: true, rationale: `LLM classifier approved: ${request.toolName}` };
      }
      // Ambiguous response — pass through
      return null;
    } catch {
      // LLM failure — pass through (don't block on classifier errors)
      return null;
    }
  };
}
