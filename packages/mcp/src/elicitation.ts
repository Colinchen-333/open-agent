/**
 * MCP Elicitation protocol handler.
 *
 * Implements the elicitation/create → elicitation/complete 2-phase protocol
 * from the MCP spec (2025-03-26). Provides a pluggable UI adapter interface so
 * the CLI, web, and test layers can each supply their own presentation logic
 * without coupling to this module.
 */

/**
 * An elicitation request from an MCP server, asking the user for input
 * needed to continue a tool invocation.
 */
export interface ElicitationRequest {
  /** Correlation ID supplied by the server. */
  elicitationId: string;
  /** The MCP server that initiated the request. */
  serverName: string;
  /** A short prompt explaining what the server needs. */
  message: string;
  /** Request shape: structured form or a URL-based flow. */
  type: 'form' | 'url';
  /** When type === 'form': schema describing the fields to collect. */
  schema?: {
    fields: Array<{
      name: string;
      label: string;
      type: 'text' | 'password' | 'select' | 'checkbox' | 'number';
      required?: boolean;
      options?: string[]; // for 'select'
      placeholder?: string;
    }>;
  };
  /** When type === 'url': URL for the user to visit (e.g. OAuth flow). */
  url?: string;
  /** Timeout in ms after which the request auto-cancels. */
  timeoutMs?: number;
}

/** Response returned to the MCP server after user input. */
export interface ElicitationResponse {
  elicitationId: string;
  /** 'accept' = user provided data; 'decline' = user refused; 'cancel' = auto-cancel/timeout. */
  action: 'accept' | 'decline' | 'cancel';
  /** For form type + accept action: the collected values keyed by field name. */
  data?: Record<string, string | number | boolean>;
  /** Optional user-provided reason for decline. */
  reason?: string;
}

/**
 * Adapter interface that handles actually collecting user input.
 * A CLI adapter prompts on stdin; a web adapter shows a modal; a test adapter
 * pre-programs responses.
 */
export interface ElicitationAdapter {
  /** Present the request to the user and return their response (or cancel). */
  present(request: ElicitationRequest): Promise<ElicitationResponse>;
}

/**
 * Auto-decline adapter: used when no UI adapter is wired.
 * Returns { action: 'decline', reason: 'No UI adapter registered' } for any request.
 */
export const AUTO_DECLINE_ADAPTER: ElicitationAdapter = {
  async present(request) {
    return {
      elicitationId: request.elicitationId,
      action: 'decline',
      reason: 'No UI adapter registered',
    };
  },
};

/**
 * Elicitation manager — tracks in-flight requests, dispatches to the adapter,
 * enforces per-request timeouts, and handles correlation.
 */
export class ElicitationManager {
  private adapter: ElicitationAdapter;
  private inFlight = new Map<string, ElicitationRequest>();

  constructor(adapter: ElicitationAdapter = AUTO_DECLINE_ADAPTER) {
    this.adapter = adapter;
  }

  /** Replace the adapter (e.g. when the UI layer initializes). */
  setAdapter(adapter: ElicitationAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Handle an incoming elicitation request from a server.
   * Presents to the adapter, enforces timeout, returns response.
   */
  async handle(request: ElicitationRequest): Promise<ElicitationResponse> {
    this.inFlight.set(request.elicitationId, request);
    try {
      const timeoutMs = request.timeoutMs ?? 5 * 60_000; // default 5 min
      const adapterPromise = this.adapter.present(request);
      const timeoutPromise = new Promise<ElicitationResponse>((resolve) => {
        setTimeout(
          () =>
            resolve({
              elicitationId: request.elicitationId,
              action: 'cancel',
              reason: `Timed out after ${timeoutMs}ms`,
            }),
          timeoutMs,
        ).unref?.();
      });
      return await Promise.race([adapterPromise, timeoutPromise]);
    } finally {
      this.inFlight.delete(request.elicitationId);
    }
  }

  /** Currently in-flight requests (for UI / debugging). */
  getInFlight(): ElicitationRequest[] {
    return [...this.inFlight.values()];
  }

  /** Force-cancel a specific in-flight request. */
  cancel(elicitationId: string, reason: string = 'Cancelled by caller'): ElicitationResponse {
    const req = this.inFlight.get(elicitationId);
    this.inFlight.delete(elicitationId);
    return {
      elicitationId,
      action: 'cancel',
      reason: req ? reason : 'Unknown elicitation id',
    };
  }
}
