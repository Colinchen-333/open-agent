import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { AutoMemory } from './auto-memory.js';
import { ConfigLoader } from './config-loader.js';
import { buildGitContextSnapshot } from './git-context.js';

export interface PromptContextSection {
  key: string;
  title: string;
  content: string;
}

export interface PromptContextOptions {
  cwd: string;
  includeGit?: boolean;
  includeMemory?: boolean;
  includeAgentInstructions?: boolean;
  additionalDirectories?: string[];
  instructionSources?: Array<'user' | 'project'>;
}

export interface PromptContextSnapshot {
  gitContext?: string;
  memoryDir?: string;
  memoryContent?: string;
  agentInstructions: string[];
  sections: PromptContextSection[];
}

export function loadPromptContext(options: PromptContextOptions): PromptContextSnapshot {
  const snapshot: PromptContextSnapshot = {
    agentInstructions: [],
    sections: [],
  };

  if (options.includeGit) {
    snapshot.gitContext = buildGitContextSnapshot(options.cwd);
  }

  if (options.includeMemory) {
    const memory = new AutoMemory(options.cwd);
    snapshot.memoryDir = memory.getDir();
    snapshot.memoryContent = memory.readMemory() || undefined;
  }

  if (options.includeAgentInstructions !== false) {
    const configLoader = new ConfigLoader();
    const loaded = configLoader.loadAgentMd(options.cwd);
    snapshot.agentInstructions = filterAgentInstructions(
      loaded,
      options.instructionSources ?? ['user', 'project'],
    );
  }

  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    snapshot.sections.push({
      key: 'additional-working-directories',
      title: 'Additional Working Directories',
      content:
        'You may read, search, and edit files in these directories in addition to the primary working directory.\n\n' +
        options.additionalDirectories.map((dir) => `- ${dir}`).join('\n'),
    });
  }

  return snapshot;
}

function filterAgentInstructions(
  instructions: string[],
  sources: Array<'user' | 'project'>,
): string[] {
  const allowed = new Set(sources);
  if (allowed.has('user') && allowed.has('project')) {
    return instructions;
  }

  const userInstructionCount = hasUserInstructionFile() ? 1 : 0;
  return instructions.filter((_instruction, index) => {
    if (index < userInstructionCount) {
      return allowed.has('user');
    }
    return allowed.has('project');
  });
}

function hasUserInstructionFile(): boolean {
  for (const path of [
    join(homedir(), '.open-agent', 'AGENT.md'),
    join(homedir(), '.claude', 'AGENT.md'),
    join(homedir(), '.claude', 'CLAUDE.md'),
  ]) {
    if (existsSync(path)) {
      return true;
    }
  }
  return false;
}
