/**
 * Bridge layer for runtime <-> frontend communication.
 * Abstracts the transport between ConversationLoop and any UI (CLI, web, SDK).
 * Matches Claude Code's bridge/sessionRunner pattern.
 */

export type BridgeMessageType =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_partial'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'status'
  | 'permission_request'
  | 'permission_response'
  | 'system'
  | 'heartbeat';

export interface BridgeMessage {
  id: string;
  type: BridgeMessageType;
  payload: unknown;
  timestamp: string;
  sessionId?: string;
}

export interface BridgeTransport {
  send(message: BridgeMessage): void | Promise<void>;
  onReceive(handler: (message: BridgeMessage) => void): void;
  close(): void | Promise<void>;
}

/** In-process transport — for same-process communication (CLI REPL, tests) */
export class InProcessTransport implements BridgeTransport {
  private handlers: Array<(msg: BridgeMessage) => void> = [];
  private peer: InProcessTransport | null = null;

  /** Connect two in-process transports bidirectionally */
  static createPair(): [InProcessTransport, InProcessTransport] {
    const a = new InProcessTransport();
    const b = new InProcessTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(message: BridgeMessage): void {
    if (this.peer) {
      for (const handler of this.peer.handlers) {
        handler(message);
      }
    }
  }

  onReceive(handler: (message: BridgeMessage) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.handlers = [];
    this.peer = null;
  }
}

/** Callback-based transport — wraps arbitrary send/receive functions */
export class CallbackTransport implements BridgeTransport {
  private handlers: Array<(msg: BridgeMessage) => void> = [];
  private sendFn: (msg: BridgeMessage) => void | Promise<void>;

  constructor(sendFn: (msg: BridgeMessage) => void | Promise<void>) {
    this.sendFn = sendFn;
  }

  send(message: BridgeMessage): void | Promise<void> {
    return this.sendFn(message);
  }

  onReceive(handler: (message: BridgeMessage) => void): void {
    this.handlers.push(handler);
  }

  /** Inject a message as if it came from the remote end */
  inject(message: BridgeMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  close(): void {
    this.handlers = [];
  }
}

/** Create a BridgeMessage with auto-generated ID and timestamp */
export function createBridgeMessage(
  type: BridgeMessageType,
  payload: unknown,
  sessionId?: string,
): BridgeMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    payload,
    timestamp: new Date().toISOString(),
    sessionId,
  };
}

/**
 * Bridge session — manages the lifecycle of a runtime <-> UI connection.
 */
export class BridgeSession {
  private transport: BridgeTransport;
  private messageHandlers = new Map<BridgeMessageType, Array<(payload: unknown) => void>>();
  private sessionId: string;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(transport: BridgeTransport, sessionId: string) {
    this.transport = transport;
    this.sessionId = sessionId;

    transport.onReceive((msg) => {
      const handlers = this.messageHandlers.get(msg.type);
      if (handlers) {
        for (const h of handlers) h(msg.payload);
      }
    });
  }

  /** Register a handler for a specific message type */
  on(type: BridgeMessageType, handler: (payload: unknown) => void): () => void {
    const handlers = this.messageHandlers.get(type) ?? [];
    handlers.push(handler);
    this.messageHandlers.set(type, handlers);
    return () => {
      const list = this.messageHandlers.get(type);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  /** Send a typed message */
  send(type: BridgeMessageType, payload: unknown): void | Promise<void> {
    return this.transport.send(createBridgeMessage(type, payload, this.sessionId));
  }

  /** Start heartbeat at interval */
  startHeartbeat(intervalMs = 10000): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      this.send('heartbeat', { alive: true });
    }, intervalMs);
  }

  /** Stop heartbeat */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Close the session */
  async close(): Promise<void> {
    this.stopHeartbeat();
    await this.transport.close();
    this.messageHandlers.clear();
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
