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
  if (request.toolName !== 'Bash') {
    // For non-Bash tools (Write/Edit/Read/Grep/etc.) we require that the
    // prompt's key terms appear in the relevant input field (e.g. file_path).
    // A bare tool-name match is NOT sufficient — it would allow
    //   { tool: "Write", prompt: "update README" }
    // to approve writing ANY file, including sensitive paths like /etc/passwd.
    for (const entry of allowedPrompts) {
      if (entry.tool !== request.toolName) continue;

      const relevantInput = extractRelevantInput(request.toolName, request.input);
      if (!relevantInput) {
        // No matchable input — refuse to auto-approve.
        return null;
      }

      const promptTerms = entry.prompt
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      if (promptTerms.length === 0) continue;

      const matchCount = promptTerms.filter((w) =>
        relevantInput.toLowerCase().includes(w),
      ).length;

      // Require at least 50% of prompt terms to appear in the relevant input.
      if (matchCount >= Math.ceil(promptTerms.length * 0.5)) return entry;
    }
    return null;
  }

  // For Bash: extract the actual command string and verify every subcommand
  // (separated by &&, ||, |, or ;) starts with a known-safe pattern derived
  // from the prompt description.  This prevents substring attacks like
  //   allowedPrompt "run tests"  matching  "rm -rf ./tests"
  // because "rm" does not start with any "run tests" safe pattern.
  const inputText = extractInputText(request.input).trim();

  for (const entry of allowedPrompts) {
    if (entry.tool !== request.toolName) continue;

    const safePatterns = buildSafePatterns(entry.prompt);

    // Split on shell operators; every subcommand must individually match.
    const subcommands = inputText.split(/\s*(?:&&|\|\|?|;)\s*/).filter(Boolean);
    const allSafe =
      subcommands.length > 0 &&
      subcommands.every((sub) => {
        const trimmed = sub.trim();
        return safePatterns.some((pattern) => matchesSafePattern(trimmed, pattern));
      });

    if (allSafe) return entry;
  }

  return null;
}

/**
 * Map a natural-language intent description (e.g. "run tests") to a list of
 * anchored RegExps that must match from the START of an individual command.
 *
 * The intent table covers the most common development workflows.  If the prompt
 * does not match any known intent key, the prompt text itself is used as an
 * anchored prefix, which handles cases like allowedPrompt = "bun run build".
 */
function buildSafePatterns(prompt: string): RegExp[] {
  const normalized = prompt.toLowerCase().trim();
  const patterns: RegExp[] = [];

  const INTENT_TO_PATTERNS: Record<string, string[]> = {
    'run tests': [
      '^bun test', '^npm test', '^yarn test', '^pnpm test',
      '^jest', '^vitest', '^pytest', '^go test', '^cargo test', '^make test',
    ],
    'install dependencies': [
      '^bun install', '^bun add', '^npm install', '^npm ci',
      '^yarn', '^pnpm install', '^pip install', '^pip3 install',
    ],
    'build': [
      '^bun run build', '^npm run build', '^yarn build',
      '^make build', '^cargo build', '^go build',
    ],
    'lint': ['^bun run lint', '^npm run lint', '^eslint', '^prettier', '^biome'],
    'format': ['^bun run format', '^npm run format', '^prettier', '^biome format'],
    'typecheck': ['^bun run typecheck', '^tsc', '^npm run typecheck'],
    'start': ['^bun run start', '^npm start', '^yarn start', '^node'],
    'git status': ['^git status', '^git diff', '^git log', '^git show', '^git branch'],
    'list files': ['^ls', '^find', '^tree', '^dir'],
    'read file': ['^cat', '^head', '^tail', '^less', '^more', '^bat'],
  };

  for (const [intent, pats] of Object.entries(INTENT_TO_PATTERNS)) {
    if (normalized === intent || normalized.includes(intent)) {
      for (const p of pats) {
        patterns.push(new RegExp(p, 'i'));
      }
    }
  }

  // Fallback: treat the prompt itself as an anchored command prefix.
  if (patterns.length === 0) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`^${escaped}`, 'i'));
  }

  return patterns;
}

/**
 * Strip common innocent prefixes (env-var assignments, sudo, time, nice) then
 * test the remaining command string against the safe pattern.
 */
function matchesSafePattern(command: string, pattern: RegExp): boolean {
  const stripped = command
    .replace(/^(\w+=\S+\s+)*/, '')         // leading env var assignments
    .replace(/^(sudo|env|time|nice)\s+/i, '') // common transparent wrappers
    .trim();
  return pattern.test(stripped);
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

/**
 * Return the single most semantically significant input field for a given tool
 * so that allowedPrompt matching can verify the prompt describes the actual
 * target (e.g. the file being written) rather than any arbitrary content.
 *
 * Returns null when no suitable field is found, which causes the caller to
 * refuse auto-approval (fail-closed).
 */
function extractRelevantInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;

  // File-system tools: match against the target path.
  if (['Write', 'Edit', 'Read', 'FileWrite', 'FileEdit', 'FileRead'].includes(toolName)) {
    return typeof i.file_path === 'string' ? i.file_path : null;
  }

  // Search tools: match against the search pattern or query string.
  if (['Grep', 'Glob', 'WebSearch'].includes(toolName)) {
    if (typeof i.pattern === 'string') return i.pattern;
    if (typeof i.query === 'string') return i.query;
    return null;
  }

  // Web fetch: match against the URL.
  if (toolName === 'WebFetch') {
    return typeof i.url === 'string' ? i.url : null;
  }

  // Generic fallback: first 200 chars of the JSON-serialised input.
  try {
    return JSON.stringify(i).slice(0, 200);
  } catch {
    return null;
  }
}

function containsApprovalPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();

  // Negation guard: if the message contains negation words before or alongside
  // approval phrases, treat the whole message as non-approving.
  const NEGATION_WORDS = ["not", "don't", "dont", "no", "never", "stop", "cancel", "不要", "不", "别"];
  if (NEGATION_WORDS.some((neg) => normalized.includes(neg))) {
    return false;
  }

  // Only match short messages — long messages that happen to contain "ok" or
  // "yes" should NOT auto-approve arbitrary tool calls.
  if (normalized.length > 50) return false;

  // Require the entire message (after trim) to be the approval phrase, or the
  // message to start/end with the phrase followed/preceded by whitespace.
  // This prevents "do not continue" or "echo ok && rm -rf /" from matching.
  return APPROVAL_PHRASES.some(
    (phrase) =>
      normalized === phrase ||
      normalized.startsWith(phrase + ' ') ||
      normalized.endsWith(' ' + phrase),
  );
}
