#!/usr/bin/env bun
import { parseArgs, TerminalRenderer, REPL, emitStreamJson } from '@open-agent/cli';
import { ConversationLoop, SessionManager } from '@open-agent/core';
import { createProvider, autoDetectProvider } from '@open-agent/providers';
import { createDefaultToolRegistry } from '@open-agent/tools';
import type { SDKMessage } from '@open-agent/core';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(`open-agent v${VERSION}`);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Provider setup
  // ------------------------------------------------------------------
  const provider = args.provider
    ? createProvider({
        provider: args.provider as 'anthropic' | 'openai' | 'ollama',
        apiKey: args.apiKey,
        baseURL: args.baseURL,
      })
    : autoDetectProvider();

  // ------------------------------------------------------------------
  // Model selection
  // ------------------------------------------------------------------
  const model = args.model ?? getDefaultModel(provider.name);

  // ------------------------------------------------------------------
  // Tool registry
  // ------------------------------------------------------------------
  const cwd = process.cwd();
  const toolRegistry = createDefaultToolRegistry(cwd);

  // ------------------------------------------------------------------
  // Session management
  // ------------------------------------------------------------------
  const sessionMgr = new SessionManager();
  let sessionId: string;

  if (args.resume) {
    // Resume an explicit session by ID.
    sessionId = args.resume;
  } else if (args.continue) {
    // Continue from the most recent session for this CWD, or create one.
    const latest = sessionMgr.getLatestSession(cwd);
    sessionId = latest ? latest.id : sessionMgr.createSession(cwd, model).id;
  } else {
    sessionId = sessionMgr.createSession(cwd, model).id;
  }

  // ------------------------------------------------------------------
  // Abort handling (Ctrl+C)
  // ------------------------------------------------------------------
  const abortController = new AbortController();
  process.on('SIGINT', () => {
    abortController.abort();
  });

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  const loop = new ConversationLoop({
    provider,
    // Pass the full tool map; ConversationLoop expects Map<name, ToolDefinition>.
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    model,
    systemPrompt: getSystemPrompt(cwd),
    maxTurns: args.maxTurns,
    thinking: { type: 'adaptive' },
    effort: 'high',
    cwd,
    sessionId,
    abortSignal: abortController.signal,
  });

  const renderer = new TerminalRenderer();
  const isStreamJson = args.outputFormat === 'stream-json';

  // ------------------------------------------------------------------
  // Single-prompt mode  (open-agent -p "…" or open-agent "…")
  // ------------------------------------------------------------------
  if (args.prompt) {
    await executePrompt(loop, args.prompt, renderer, isStreamJson, sessionMgr, cwd, sessionId);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Interactive REPL mode
  // ------------------------------------------------------------------
  renderer.renderWelcome(model);
  const repl = new REPL(model);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await repl.getInput();

    if (input === null) {
      // EOF — user pressed Ctrl+D
      console.log('\nGoodbye!');
      break;
    }

    if (input === '') continue;

    // Built-in slash commands
    if (input === '/exit' || input === '/quit') break;
    if (input === '/clear') {
      console.clear();
      continue;
    }

    await executePrompt(loop, input, renderer, isStreamJson, sessionMgr, cwd, sessionId);
  }

  repl.close();
}

// ---------------------------------------------------------------------------
// Helper: run one prompt through the conversation loop and render output
// ---------------------------------------------------------------------------
async function executePrompt(
  loop: ConversationLoop,
  prompt: string,
  renderer: TerminalRenderer,
  isStreamJson: boolean,
  sessionMgr: SessionManager,
  cwd: string,
  sessionId: string,
): Promise<void> {
  for await (const message of loop.run(prompt)) {
    if (isStreamJson) {
      emitStreamJson(message);
    } else {
      renderMessage(renderer, message);
    }
    // Persist every message to the on-disk transcript.
    sessionMgr.appendToTranscript(cwd, sessionId, message);
  }
}

function renderMessage(renderer: TerminalRenderer, message: SDKMessage): void {
  switch (message.type) {
    case 'stream_event':
      renderer.renderStreamEvent(message.event);
      break;
    case 'result':
      renderer.renderResult(message as Record<string, any>);
      break;
    // 'user', 'assistant', 'system' messages are informational only; no
    // terminal output is needed for them in the default renderer.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getDefaultModel(providerName: string): string {
  switch (providerName) {
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o';
    case 'ollama':
      return 'llama3';
    default:
      return 'claude-sonnet-4-6';
  }
}

function getSystemPrompt(cwd: string): string {
  return `You are OpenAgent, an AI coding assistant. You help users with software engineering tasks.

Current working directory: ${cwd}

You have access to tools for reading files, writing files, editing files, executing shell commands, searching files by name patterns, and searching file contents.

Be concise and helpful. When asked to modify code, read the relevant files first to understand the context.`;
}

function printHelp(): void {
  console.log(`
OpenAgent - AI Coding Assistant

Usage: open-agent [options] [prompt]

Options:
  -m, --model <model>         Model to use (default: auto-detect per provider)
  -p, --prompt <text>         Run a single prompt and exit
  -r, --resume <id>           Resume a previous session by ID
  -c, --continue              Continue the most recent session in this directory
      --provider <name>       LLM provider: anthropic | openai | ollama
      --api-key <key>         API key for the chosen provider
      --base-url <url>        Base URL for the provider API
      --permission-mode <m>   Permission mode: default | acceptEdits | bypassPermissions
      --output-format <fmt>   Output format: text | stream-json
      --max-turns <n>         Maximum conversation turns
      --print                 Print-only mode (no tool calls)
      --verbose, --debug      Enable verbose output
  -h, --help                  Show this help message
  -v, --version               Show version number

Slash commands (REPL mode):
  /exit, /quit                Exit the REPL
  /clear                      Clear the terminal screen
  `);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
