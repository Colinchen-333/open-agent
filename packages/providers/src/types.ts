import type { ModelInfo, ThinkingConfig } from '@open-agent/core';

export interface LLMProvider {
  chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent>;
  listModels(): Promise<ModelInfo[]>;
  readonly name: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking';
  [key: string]: any;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'message_start'; message: any }
  | { type: 'message_end'; message: any; usage?: any }
  | { type: 'content_block_start'; index: number; content_block: any }
  | { type: 'content_block_delta'; index: number; delta: any }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: any; usage?: any }
  | { type: 'error'; error: any };

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  tools?: ToolSpec[];
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: string;
  stopSequences?: string[];
  /** AbortSignal to cancel the in-flight HTTP request (Ctrl+C support). */
  signal?: AbortSignal;
  /** Structured output format (e.g. JSON schema). */
  responseFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}
