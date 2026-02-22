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

// Built-in agent types
export const BUILTIN_AGENT_TYPES: Record<string, AgentDefinition> = {
  'Explore': {
    description: 'Fast agent for exploring codebases',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write', 'Task'],
    prompt: 'You are an exploration agent. Search and read code to answer questions. Do not modify any files.',
    mode: 'default',
    allowBackgroundExecution: true,
  },
  'Plan': {
    description: 'Software architect for designing implementation plans',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    prompt: 'You are a planning agent. Design implementation strategies and identify critical files. Do not write code.',
    mode: 'plan',
  },
  'code-writer': {
    description: 'Agent for writing new code and implementing features',
    prompt: 'You are a code writing agent. Implement features, create functions, and write code as requested.',
    mode: 'acceptEdits',
    allowBackgroundExecution: true,
  },
  'architecture-logic-reviewer': {
    description: 'Agent for reviewing code architecture and logic',
    prompt: 'You are a code review agent. Review architecture decisions, verify logic flow, and validate implementations.',
    mode: 'default',
    allowBackgroundExecution: true,
  },
  'general-purpose': {
    description: 'General-purpose agent with all tools available',
    prompt: 'You are a general-purpose agent. Handle complex, multi-step tasks autonomously.',
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
