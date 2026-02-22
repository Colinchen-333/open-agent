// Tool input types - precisely reproduced from sdk-tools.d.ts

export interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

export interface FileWriteInput {
  file_path: string;
  content: string;
}

export interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-B'?: number;
  '-A'?: number;
  '-C'?: number;
  context?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

// Tool output types

/**
 * @deprecated The bash tool now returns a plain `string` instead of BashOutput.
 * This interface is kept for backwards compatibility only and will be removed in a future version.
 */
export interface BashOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  backgroundTaskId?: string;
}

export interface GlobOutput {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export interface GrepOutput {
  mode?: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
}

// Tool definition interface
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema
  execute(input: any, context: ToolContext): Promise<any>;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId: string;
}
