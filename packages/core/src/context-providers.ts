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

export interface PromptContextProviderResult {
  gitContext?: string;
  memoryDir?: string;
  memoryContent?: string;
  agentInstructions?: string[];
  sections?: PromptContextSection[];
}

export interface PromptContextProvider {
  key: string;
  provide(options: PromptContextOptions): PromptContextProviderResult | null;
}

export const DEFAULT_PROMPT_CONTEXT_PROVIDERS: PromptContextProvider[] = [
  createGitContextProvider(),
  createMemoryContextProvider(),
  createAgentInstructionsProvider(),
  createAdditionalDirectoriesProvider(),
];

export function loadPromptContext(
  options: PromptContextOptions,
  providers: PromptContextProvider[] = DEFAULT_PROMPT_CONTEXT_PROVIDERS,
): PromptContextSnapshot {
  const snapshot: PromptContextSnapshot = {
    agentInstructions: [],
    sections: [],
  };

  for (const provider of providers) {
    const result = provider.provide(options);
    if (!result) continue;

    if (result.gitContext !== undefined) {
      snapshot.gitContext = result.gitContext;
    }
    if (result.memoryDir !== undefined) {
      snapshot.memoryDir = result.memoryDir;
    }
    if (result.memoryContent !== undefined) {
      snapshot.memoryContent = result.memoryContent;
    }
    if (result.agentInstructions !== undefined) {
      snapshot.agentInstructions = result.agentInstructions;
    }
    if (result.sections && result.sections.length > 0) {
      snapshot.sections.push(...result.sections);
    }
  }

  return snapshot;
}

export function createGitContextProvider(): PromptContextProvider {
  return {
    key: 'git',
    provide(options): PromptContextProviderResult | null {
      if (!options.includeGit) return null;

      const gitContext = buildGitContextSnapshot(options.cwd);
      if (!gitContext) return null;

      return {
        gitContext,
        sections: [
          {
            key: 'git-context',
            title: 'Git Context',
            content: gitContext,
          },
        ],
      };
    },
  };
}

export function createMemoryContextProvider(): PromptContextProvider {
  return {
    key: 'memory',
    provide(options): PromptContextProviderResult | null {
      if (!options.includeMemory) return null;

      const memory = new AutoMemory(options.cwd);
      const memoryDir = memory.getDir();
      const memoryContent = memory.readMemory() || undefined;

      const content = memoryContent
        ? `Persistent memory directory: \`${memoryDir}\`.\n\nCurrent MEMORY.md contents:\n\n${memoryContent}`
        : `Persistent memory directory: \`${memoryDir}\`.\n\nCurrent MEMORY.md contents: (empty)`;

      return {
        memoryDir,
        memoryContent,
        sections: [
          {
            key: 'memory-context',
            title: 'Memory Context',
            content,
          },
        ],
      };
    },
  };
}

export function createAgentInstructionsProvider(): PromptContextProvider {
  return {
    key: 'agent-instructions',
    provide(options): PromptContextProviderResult | null {
      if (options.includeAgentInstructions === false) return null;

      const configLoader = new ConfigLoader();
      const loaded = configLoader.loadAgentMd(options.cwd);
      return {
        agentInstructions: filterAgentInstructions(
          loaded,
          options.instructionSources ?? ['user', 'project'],
        ),
      };
    },
  };
}

export function createAdditionalDirectoriesProvider(): PromptContextProvider {
  return {
    key: 'additional-directories',
    provide(options): PromptContextProviderResult | null {
      const additionalDirectories = options.additionalDirectories ?? [];
      if (additionalDirectories.length === 0) return null;

      return {
        sections: [
          {
            key: 'additional-working-directories',
            title: 'Additional Working Directories',
            content:
              'You may read, search, and edit files in these directories in addition to the primary working directory.\n\n' +
              additionalDirectories.map((dir) => `- ${dir}`).join('\n'),
          },
        ],
      };
    },
  };
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
