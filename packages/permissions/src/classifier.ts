import type { PermissionRequest } from './types';

// ── Safe-tool whitelist (matches Claude Code's SAFE_YOLO_ALLOWLISTED_TOOLS) ──
//
// Tools on this list get instant auto-approve without any LLM call.
// They are all read-only or purely informational — they cannot cause damage,
// modify state, or exfiltrate data in ways that require gating.
const SAFE_AUTO_APPROVE_TOOLS = new Set([
  // ── Read-only filesystem / network ──
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',

  // ── MCP read-only resources (use actual registered tool names) ──
  'ListMcpResourcesTool', 'ReadMcpResourceTool',

  // ── Task reads (read-only) ──
  'TaskList', 'TaskGet',

  // ── Interaction / informational ──
  'AskUserQuestion', 'ToolSearch',

  // ── Side-effect free ──
  'Sleep', 'CronList',

  // ── Read-only LSP queries ──
  'LSP',

  // NOT included (state-changing):
  //   TodoWrite    — mutates the todo list
  //   TaskCreate   — creates new task records
  //   TaskUpdate   — mutates task state
  //   EnterPlanMode / ExitPlanMode / ExitPlanModeV2 — changes permission mode
  //   Brief        — mutates app state
]);

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

export interface LLMClassifierProvider {
  classify(prompt: string): Promise<string>;
}

/**
 * Claude Code-aligned permission classifier.
 *
 * Architecture (3 stages, first match wins):
 *
 *   Stage 0 — Safe-tool whitelist
 *     Tools in SAFE_AUTO_APPROVE_TOOLS get instant auto-approve.
 *     No LLM call, no prompt matching — fast path.
 *
 *   Stage 1 — Tool annotation
 *     Tools annotated { readOnly: true } are auto-approved.
 *     This covers dynamic/MCP tools that declare themselves safe.
 *
 *   Stage 2 — LLM classifier
 *     For all other tools, an LLM evaluates the request using the full
 *     transcript context and allowedPrompts as semantic hints.
 *     If no LLM provider is configured, returns null (ask the user).
 *
 * Critically: there is NO keyword/regex matching on allowedPrompts.
 * The LLM understands semantic intent; string operations do not.
 */
export async function classifyPermissionRequest(
  request: PermissionRequest,
  context: ClassifierContext,
): Promise<ClassifierDecision | null> {

  // ── Stage 0: Safe-tool whitelist (fast path, no LLM) ──
  if (SAFE_AUTO_APPROVE_TOOLS.has(request.toolName)) {
    return { approved: true, rationale: `safe-tool whitelist: ${request.toolName}` };
  }

  // ── Stage 1: Annotation-based auto-approve ──
  if (request.annotations?.readOnly === true) {
    return { approved: true, rationale: 'read-only tool annotation' };
  }

  // ── Stage 2: LLM classifier (the real decision engine) ──
  if (!context.llmProvider) {
    // No LLM available — pass through (let the prompt stage ask the user).
    return null;
  }

  return classifyWithLLM(request, context);
}

/**
 * LLM-based classification. Builds a structured prompt with:
 * - The tool name and input
 * - The allowedPrompts (as semantic hints, not keyword rules)
 * - Recent transcript context
 * - Tool annotations
 *
 * The LLM returns APPROVE or BLOCK. No keyword matching — the LLM
 * understands the semantic relationship between the intent and the action.
 * This prevents privilege-escalation attacks like "rm -rf ./tests" matching
 * an allowedPrompt of "run tests" that defeated naive regex approaches.
 */
async function classifyWithLLM(
  request: PermissionRequest,
  context: ClassifierContext,
): Promise<ClassifierDecision | null> {
  const toolInput = typeof request.input === 'string'
    ? request.input
    : JSON.stringify(request.input).slice(0, 1000);

  const allowedPromptsSection = context.allowedPrompts?.length
    ? `\nPre-approved intents from the current plan:\n${context.allowedPrompts.map((p) => `- ${p.tool}: ${p.prompt}`).join('\n')}\n\nThese are semantic descriptions of APPROVED categories. If the tool call matches the INTENT (not exact words) of any approved category, it should be allowed.`
    : '';

  const recentContext = context.recentUserMessages?.slice(-3).join('\n') || '(no recent context)';

  const annotationInfo = request.annotations
    ? `\nTool annotations: ${JSON.stringify(request.annotations)}`
    : '';

  const prompt = `You are a security classifier for a coding assistant. Evaluate whether this tool call should be automatically approved or blocked.

Tool: ${request.toolName}
Input: ${toolInput}
${annotationInfo}
${allowedPromptsSection}

Recent user conversation:
${recentContext}

Rules:
- APPROVE if the action is clearly safe and matches the user's intent
- APPROVE if the action matches a pre-approved intent category
- BLOCK if the action could cause damage, data loss, or unintended side effects
- BLOCK if the action doesn't match any approved intent and is potentially destructive
- When in doubt, BLOCK (fail-safe)

Respond with exactly one word on the first line: APPROVE or BLOCK
Then optionally a brief reason on the second line.`;

  try {
    const response = await context.llmProvider!.classify(prompt);
    const lines = response.trim().split('\n');
    const firstLine = lines[0]?.trim().toUpperCase() ?? '';
    const reason = lines.slice(1).join(' ').trim() || '';

    // Word-boundary matching for safety — prevents "DISAPPROVE" matching APPROVE,
    // or "BLOCKADE" matching BLOCK.
    if (/\bBLOCK\b/.test(firstLine)) {
      return { approved: false, rationale: `LLM classifier blocked: ${reason || request.toolName}` };
    }
    if (/\bAPPROVE\b/.test(firstLine)) {
      return { approved: true, rationale: `LLM classifier approved: ${reason || request.toolName}` };
    }

    // Ambiguous response — fail-safe to null (ask user).
    return null;
  } catch {
    // LLM failure — pass through (don't block on classifier errors).
    return null;
  }
}

// ── Exports ──
export { SAFE_AUTO_APPROVE_TOOLS };
