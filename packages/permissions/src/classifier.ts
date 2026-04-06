import type { PermissionRequest } from './types';
import { type LLMClassifierProvider, createLLMClassifier } from './llm-classifier.js';

export interface ClassifierContext {
  /** Recent user messages from the transcript (newest last). Max 10 recommended. */
  recentUserMessages?: string[];
  /** Allowed prompts registered via ExitPlanModeV2. */
  allowedPrompts?: ReadonlyArray<{ tool: string; prompt: string }>;
  /** Optional LLM provider for model-backed classification. */
  llmProvider?: LLMClassifierProvider;
}

export interface ClassifierDecision {
  approved: boolean;
  rationale: string;
}

const APPROVAL_PHRASES = [
  'yes',
  'go ahead',
  'proceed',
  'continue',
  'do it',
  'confirmed',
  'approved',
  'looks good',
  'lgtm',
  '继续',
  '批准',
  '确认',
  '好的',
  '同意',
];

/**
 * Rule-based classifier for auto-approving permission requests.
 *
 * Rules (first match wins):
 *   1. Tool is annotated readOnly → approve with rationale "read-only tool"
 *   2. Tool matches an allowedPrompt entry where the prompt keywords appear in the request input → approve
 *   3. Most recent user message contains an approval phrase → approve
 *   4. LLM-backed classification (if context.llmProvider is set) → delegate to model
 *   5. Otherwise → return null (pass-through; let the pipeline continue to prompt stage)
 */
export async function classifyPermissionRequest(
  request: PermissionRequest,
  context: ClassifierContext,
): Promise<ClassifierDecision | null> {
  // Rule 1: readOnly annotation
  if (request.annotations?.readOnly === true) {
    return { approved: true, rationale: 'read-only tool' };
  }

  // Rule 2: allowedPrompts semantic match
  if (context.allowedPrompts && context.allowedPrompts.length > 0) {
    const match = findAllowedPromptMatch(request, context.allowedPrompts);
    if (match) {
      return { approved: true, rationale: `matches allowed prompt: "${match.prompt}"` };
    }
  }

  // Rule 3: recent explicit user approval
  if (context.recentUserMessages && context.recentUserMessages.length > 0) {
    const latest = context.recentUserMessages[context.recentUserMessages.length - 1];
    if (latest && containsApprovalPhrase(latest)) {
      return { approved: true, rationale: 'user explicitly approved in recent message' };
    }
  }

  // Rule 4: LLM-backed classification (if provider available)
  if (context.llmProvider) {
    const llmClassify = createLLMClassifier(context.llmProvider);
    const llmDecision = await llmClassify(request, context);
    if (llmDecision) return llmDecision;
  }

  return null;
}

function findAllowedPromptMatch(
  request: PermissionRequest,
  allowedPrompts: ReadonlyArray<{ tool: string; prompt: string }>,
): { tool: string; prompt: string } | null {
  const inputText = extractInputText(request.input).toLowerCase();
  const inputTokens = inputText.split(/\s+/).filter((t) => t.length > 0);
  for (const entry of allowedPrompts) {
    if (entry.tool !== request.toolName) continue;
    // Keyword overlap: all meaningful prompt words must appear in the input.
    // Matching uses stem-prefix logic: a prompt word matches if the input contains
    // a token that is a prefix of the prompt word or the prompt word is a prefix
    // of an input token. This handles inflections like "tests" ↔ "test".
    const promptWords = entry.prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3); // drop trivial short words (≤3 chars)
    if (promptWords.length === 0) continue;
    const allMatch = promptWords.every((pw) =>
      inputText.includes(pw) ||
      inputTokens.some((tok) => tok.startsWith(pw) || pw.startsWith(tok)),
    );
    if (allMatch) {
      return entry;
    }
  }
  return null;
}

function extractInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    // Common tool input shapes: { command: "..." }, { file_path: "...", content: "..." }, etc.
    return Object.values(input as Record<string, unknown>)
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return '';
}

function containsApprovalPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return APPROVAL_PHRASES.some((phrase) => normalized.includes(phrase));
}
