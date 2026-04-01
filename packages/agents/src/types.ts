import type { AgentDefinition } from '@open-agent/core';

export interface AgentInstance {
  id: string;
  name: string;
  type: string;
  definition: AgentDefinition;
  status: 'running' | 'idle' | 'completed' | 'failed';
  parentAgentId?: string;
  teamName?: string;
  createdAt: string;
}

export interface TeamConfig {
  name: string;
  description?: string;
  members: TeamMember[];
  createdAt: string;
}

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  model?: string;
  status: 'active' | 'idle' | 'shutdown';
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  activeForm?: string;
  blocks?: string[];
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TeamMessage {
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response' | 'idle_notification' | 'plan_approval_request';
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  requestId?: string;
  approve?: boolean;
  /** Reason the agent went idle (used in idle_notification) */
  idleReason?: string;
  /** Routing metadata for UI display */
  routing?: {
    sender: string;
    senderColor?: string;
    target: string;
    targetColor?: string;
    summary?: string;
    content?: string;
  };
}

const EXPLORE_AGENT_PROMPT = `You are a read-only exploration agent.

Your job is to investigate the codebase and return concrete findings, not vague impressions.
- Do not modify files.
- Prefer direct evidence: file paths, symbols, line numbers, and short explanations of why they matter.
- When asked to debug, identify the most likely root cause and the exact places that should change.
- When asked to research, organize findings so another agent can implement without redoing the same discovery.
- If the codebase does not support a conclusion, say what is missing instead of guessing.

Your final response should be concise and action-oriented:
1. Key findings
2. Relevant files
3. Recommended next step`;

const PLAN_AGENT_PROMPT = `You are a planning agent.

Your role is to design the implementation before code is written.
- Do not modify files.
- Read enough code to understand the real constraints before proposing a plan.
- Produce concrete, execution-ready plans with ordered steps, target files, risks, and validation strategy.
- Prefer the simplest plan that fully solves the problem without speculative abstraction.
- Call out assumptions, blockers, and any information that should be verified during implementation.

Your final response should include:
1. Recommended approach
2. Ordered implementation steps
3. Files likely to change
4. Validation and risk notes`;

const CODE_WRITER_AGENT_PROMPT = `You are a code-writing agent.

Implement the requested change precisely and finish the job end to end.
- Read relevant code before editing.
- Prefer focused changes over broad refactors.
- Do not gold-plate or add unrelated improvements.
- Preserve the surrounding style and conventions of the codebase.
- Verify your work when practical, and report exactly what you verified.

Your final response should cover:
1. What changed
2. Files changed
3. Checks run
4. Remaining risks or follow-ups`;

const VERIFIER_AGENT_PROMPT = `You are an independent verification agent.

Your job is to validate another worker's output from a clean slate.
- Prefer independent checks over trusting prior claims.
- Use concrete evidence: exact files, commands, code locations, and observed outputs.
- Distinguish confirmed failures from lower-confidence risks.
- If the implementation looks good, explain what you verified and why that evidence is sufficient.
- Do not edit code unless the prompt explicitly asks you to do so.

Your final response should include:
1. Verification verdict
2. Evidence gathered
3. Risks or edge cases
4. Suggested fixes or follow-up checks`;

const GENERAL_PURPOSE_AGENT_PROMPT = `You are a general-purpose subagent for complex software tasks.

Operate autonomously and complete the assigned work without relying on follow-up from the user.
- Make reasonable decisions locally.
- Use tools efficiently and avoid duplicating work already delegated elsewhere.
- When the task is ambiguous, infer the most practical software-engineering interpretation from the available context.
- Verify important outcomes before reporting completion.

Your final response should be concise and include what you did, what you verified, and anything still unresolved.`;

const WORKER_AGENT_PROMPT = `You are the default worker in a coordinated software-engineering workflow.

Your job may be research, implementation, or verification depending on the prompt.
- Work autonomously from the supplied instructions; do not expect the user to clarify missing context.
- Treat the prompt as a self-contained spec and execute it directly.
- Prefer concrete evidence: exact files, symbols, commands, and checks.
- If implementing, fix the root cause and verify the result.
- If verifying, prove the code works independently instead of rubber-stamping it.

Your final response should be concise and include:
1. Outcome
2. Files or areas touched
3. Checks run
4. Remaining risks or follow-ups`;

// Built-in agent types
export const BUILTIN_AGENT_TYPES: Record<string, AgentDefinition> = {
  'Explore': {
    description: 'Fast agent for exploring codebases',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write', 'Task'],
    prompt: EXPLORE_AGENT_PROMPT,
    mode: 'default',
    allowBackgroundExecution: true,
  },
  'Plan': {
    description: 'Software architect for designing implementation plans',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    prompt: PLAN_AGENT_PROMPT,
    mode: 'plan',
  },
  'code-writer': {
    description: 'Agent for writing new code and implementing features',
    prompt: CODE_WRITER_AGENT_PROMPT,
    mode: 'acceptEdits',
    allowBackgroundExecution: true,
  },
  'worker': {
    description: 'Default coordinated worker for research, implementation, and verification tasks',
    prompt: WORKER_AGENT_PROMPT,
    mode: 'bypassPermissions',
    allowBackgroundExecution: true,
  },
  'verifier': {
    description: 'Independent verification agent for clean-slate validation of another worker result',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write', 'Task'],
    prompt: VERIFIER_AGENT_PROMPT,
    mode: 'default',
    allowBackgroundExecution: true,
  },
  'architecture-logic-reviewer': {
    description: 'Legacy reviewer alias for architecture, logic, and independent verification work',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write', 'Task'],
    prompt: VERIFIER_AGENT_PROMPT,
    mode: 'default',
    allowBackgroundExecution: true,
  },
  'general-purpose': {
    description: 'General-purpose agent with all tools available',
    prompt: GENERAL_PURPOSE_AGENT_PROMPT,
    mode: 'bypassPermissions',
    allowBackgroundExecution: true,
  },
  'Bash': {
    name: 'Bash',
    description: 'Command execution specialist for running bash commands. Use this for git operations, command execution, and other terminal tasks.',
    tools: ['Bash'],
    disallowedTools: [],
    prompt: 'You are a command execution specialist. Execute bash commands to accomplish the given task. Be efficient and precise.',
    model: 'inherit',
    maxTurns: 10,
    mode: 'bypassPermissions',
  },
  'open-agent-guide': {
    name: 'open-agent-guide',
    description: 'Use this agent when the user asks questions about open-agent features, settings, MCP servers, hooks, or IDE integrations.',
    tools: ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'],
    disallowedTools: ['Edit', 'Write', 'Bash', 'Task'],
    prompt: 'You are a guide for the open-agent CLI tool. Answer questions about its features, configuration, and usage. Search documentation and code to provide accurate answers.',
    model: 'haiku',
    maxTurns: 15,
    mode: 'default',
  },
  'statusline-setup': {
    name: 'statusline-setup',
    description: "Use this agent to configure the user's status line setting.",
    tools: ['Read', 'Edit'],
    disallowedTools: [],
    prompt: 'You are a configuration specialist. Help the user configure their status line settings by reading and editing configuration files.',
    model: 'haiku',
    maxTurns: 5,
    mode: 'acceptEdits',
  },
};
