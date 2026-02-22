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
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response';
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  requestId?: string;
  approve?: boolean;
}

// Built-in agent types
export const BUILTIN_AGENT_TYPES: Record<string, AgentDefinition> = {
  'Explore': {
    description: 'Fast agent for exploring codebases',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write', 'Task'],
    prompt: 'You are an exploration agent. Search and read code to answer questions. Do not modify any files.',
  },
  'Plan': {
    description: 'Software architect for designing implementation plans',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
    prompt: 'You are a planning agent. Design implementation strategies and identify critical files. Do not write code.',
  },
  'code-writer': {
    description: 'Agent for writing new code and implementing features',
    prompt: 'You are a code writing agent. Implement features, create functions, and write code as requested.',
  },
  'architecture-logic-reviewer': {
    description: 'Agent for reviewing code architecture and logic',
    prompt: 'You are a code review agent. Review architecture decisions, verify logic flow, and validate implementations.',
  },
  'general-purpose': {
    description: 'General-purpose agent with all tools available',
    prompt: 'You are a general-purpose agent. Handle complex, multi-step tasks autonomously.',
  },
};
