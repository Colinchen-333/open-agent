import type { ToolDefinition, ToolContext } from '@open-agent/tools';
import type { SDKToolResultMessage, SDKProgressMessage } from './types.js';
import { randomUUID } from 'crypto';

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type TrackedToolStatus = 'queued' | 'executing' | 'completed';

interface TrackedTool {
  block: ToolUseBlock;
  status: TrackedToolStatus;
  result?: SDKToolResultMessage;
}

export class StreamingToolExecutor {
  private queue: TrackedTool[] = [];
  private tools: Map<string, ToolDefinition>;
  private context: ToolContext;
  private abortController = new AbortController();
  private sessionId: string;

  constructor(tools: Map<string, ToolDefinition>, context: ToolContext, sessionId: string) {
    this.tools = tools;
    this.context = context;
    this.sessionId = sessionId;
  }

  addTool(block: ToolUseBlock): void {
    this.queue.push({ block, status: 'queued' });
  }

  async *getResults(): AsyncGenerator<SDKToolResultMessage | SDKProgressMessage> {
    if (this.queue.length === 0) return;

    // Determine concurrency safety for each queued tool
    const concurrent: TrackedTool[] = [];
    const sequential: TrackedTool[] = [];

    for (const tracked of this.queue) {
      const tool = this.tools.get(tracked.block.name);
      if (!tool) {
        // Unknown tool — will be handled as error during execution
        sequential.push(tracked);
        continue;
      }
      const isSafe = typeof tool.isConcurrencySafe === 'function'
        ? tool.isConcurrencySafe(tracked.block.input)
        : (tool.isConcurrencySafe ?? true);

      if (isSafe) {
        concurrent.push(tracked);
      } else {
        sequential.push(tracked);
      }
    }

    // Execute concurrent batch in parallel
    if (concurrent.length > 0) {
      await Promise.all(concurrent.map(t => this.executeTool(t)));
    }

    // Execute sequential tools one by one
    for (const tracked of sequential) {
      if (this.abortController.signal.aborted) {
        tracked.status = 'completed';
        tracked.result = this.makeErrorResult(tracked.block, 'Aborted');
        continue;
      }
      await this.executeTool(tracked);
    }

    // Yield all results in original add order
    for (const tracked of this.queue) {
      if (tracked.result) {
        yield tracked.result;
      }
    }
  }

  abort(): void {
    this.abortController.abort();
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    tracked.status = 'executing';
    const tool = this.tools.get(tracked.block.name);

    if (!tool) {
      tracked.status = 'completed';
      tracked.result = this.makeErrorResult(tracked.block, `Unknown tool: ${tracked.block.name}`);
      return;
    }

    try {
      const toolCtx: ToolContext = {
        ...this.context,
        toolUseId: tracked.block.id,
        abortSignal: this.abortController.signal,
      };

      // ── validateInput hook — runs before execution ──────────────────────
      if (tool.validateInput) {
        const validation = tool.validateInput(tracked.block.input, toolCtx);
        if (validation && !validation.valid) {
          tracked.status = 'completed';
          tracked.result = this.makeErrorResult(
            tracked.block,
            `Validation error (${validation.errorCode}): ${validation.errorMessage}`,
          );
          return;
        }
      }

      const result = await Promise.race([
        tool.execute(tracked.block.input, toolCtx),
        this.waitForAbort(),
      ]);

      tracked.status = 'completed';
      const resultStr = JSON.stringify(result);
      tracked.result = {
        type: 'tool_result',
        tool_name: tracked.block.name,
        tool_use_id: tracked.block.id,
        result: resultStr,
        is_error: false,
        uuid: randomUUID(),
        session_id: this.sessionId,
      };
    } catch (err) {
      tracked.status = 'completed';
      if (this.abortController.signal.aborted) {
        tracked.result = this.makeErrorResult(tracked.block, 'Aborted');
      } else {
        tracked.result = this.makeErrorResult(
          tracked.block,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private makeErrorResult(block: ToolUseBlock, error: string): SDKToolResultMessage {
    return {
      type: 'tool_result',
      tool_name: block.name,
      tool_use_id: block.id,
      result: error,
      is_error: true,
      uuid: randomUUID(),
      session_id: this.sessionId,
    };
  }

  private waitForAbort(): Promise<never> {
    return new Promise((_, reject) => {
      if (this.abortController.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      this.abortController.signal.addEventListener('abort', () => {
        reject(new Error('Aborted'));
      }, { once: true });
    });
  }
}
