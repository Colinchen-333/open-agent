/**
 * Agent taxonomy matching Claude Code's multi-agent coordination model.
 */

/** Agent execution mode */
export type AgentMode = 'coordinator' | 'normal' | 'dream' | 'background';

/** Teammate definition — an agent spawned by a coordinator */
export interface TeammateSpec {
  /** Agent name (must be unique within team) */
  name: string;
  /** Agent type/definition to use */
  agentType: string;
  /** Task description for this teammate */
  task: string;
  /** Model override (if different from coordinator) */
  model?: string;
  /** Permission mode override */
  permissionMode?: string;
  /** Working directory (if different from coordinator) */
  cwd?: string;
}

/** Coordinator state */
export interface CoordinatorState {
  mode: 'coordinator';
  /** Team name for grouping teammates */
  teamName: string;
  /** Spawned teammates */
  teammates: TeammateStatus[];
  /** Maximum concurrent teammates */
  maxConcurrent: number;
  /** Whether to auto-assign tasks from the queue */
  autoAssign: boolean;
}

export interface TeammateStatus {
  name: string;
  agentId: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  task: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

/** Mailbox for inter-agent communication */
export interface AgentMailbox {
  /** Pending messages for this agent */
  messages: MailboxMessage[];
}

export interface MailboxMessage {
  id: string;
  from: string; // sender agent name
  to: string;   // recipient agent name
  content: string;
  timestamp: string;
  read: boolean;
}

/**
 * In-memory mailbox registry for multi-agent communication.
 */
const mailboxes = new Map<string, AgentMailbox>();

/** Get or create a mailbox for an agent. */
export function getMailbox(agentName: string): AgentMailbox {
  let box = mailboxes.get(agentName);
  if (!box) {
    box = { messages: [] };
    mailboxes.set(agentName, box);
  }
  return box;
}

/** Send a message to another agent's mailbox. */
export function sendMessage(from: string, to: string, content: string): MailboxMessage {
  const msg: MailboxMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    from,
    to,
    content,
    timestamp: new Date().toISOString(),
    read: false,
  };
  getMailbox(to).messages.push(msg);
  return msg;
}

/** Read unread messages from an agent's mailbox. Marks them as read. */
export function readMessages(agentName: string): MailboxMessage[] {
  const box = getMailbox(agentName);
  const unread = box.messages.filter(m => !m.read);
  for (const m of unread) m.read = true;
  return unread;
}

/** Get all messages (read + unread) for an agent. */
export function getAllMessages(agentName: string): MailboxMessage[] {
  return [...getMailbox(agentName).messages];
}

/** Clear all mailboxes (for testing/new session). */
export function resetMailboxes(): void {
  mailboxes.clear();
}

/** Determine agent mode from session metadata. */
export function resolveAgentMode(opts: {
  isCoordinator?: boolean;
  isBackground?: boolean;
  isDream?: boolean;
}): AgentMode {
  if (opts.isCoordinator) return 'coordinator';
  if (opts.isDream) return 'dream';
  if (opts.isBackground) return 'background';
  return 'normal';
}
