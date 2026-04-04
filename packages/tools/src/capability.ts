import type {
  ResolvedToolCapability,
  ToolCapability,
  ToolCapabilityExportEntry,
  ToolDefinition,
  ToolCapabilityCategory,
  ToolCapabilityRisk,
} from './types.js';

const BUILTIN_CAPABILITY_OVERRIDES: Record<string, Partial<ToolCapability>> = {
  Read: { category: 'filesystem', tags: ['read', 'inspect'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  Write: { category: 'filesystem', tags: ['write', 'mutate'], risk: 'medium', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
  Edit: { category: 'filesystem', tags: ['edit', 'mutate'], risk: 'medium', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
  Bash: { category: 'shell', tags: ['command', 'process'], risk: 'high', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
  Glob: { category: 'search', tags: ['glob', 'filesystem'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  Grep: { category: 'search', tags: ['grep', 'filesystem'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  WebFetch: { category: 'web', tags: ['fetch', 'network'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  NotebookEdit: { category: 'filesystem', tags: ['notebook', 'edit'], risk: 'medium', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
  AskUserQuestion: { category: 'utility', tags: ['interactive', 'prompt'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  WebSearch: { category: 'web', tags: ['search', 'network'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  Config: { category: 'configuration', tags: ['settings'], risk: 'medium', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
  TaskOutput: { category: 'task', tags: ['inspect', 'background'], risk: 'low', needsWorkspaceWrite: false, readOnly: true, concurrencySafe: true },
  TaskStop: { category: 'task', tags: ['control', 'background'], risk: 'medium', needsWorkspaceWrite: false, readOnly: false, concurrencySafe: true },
  EnterWorktree: { category: 'workspace', tags: ['git', 'isolation'], risk: 'medium', needsWorkspaceWrite: true, readOnly: false, concurrencySafe: false },
};

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function inferCategoryFromName(tool: ToolDefinition): ToolCapabilityCategory {
  const name = tool.name.toLowerCase();

  if (['read', 'write', 'edit', 'notebookedit'].includes(name)) return 'filesystem';
  if (name.includes('bash') || name.includes('shell')) return 'shell';
  if (['glob', 'grep', 'toolsearch'].includes(name)) return 'search';
  if (name.startsWith('web')) return 'web';
  if (name.includes('task')) return 'task';
  if (name.includes('team') || name.includes('agent')) return 'agent';
  if (name.includes('worktree')) return 'workspace';
  if (name.includes('config')) return 'configuration';
  if (name.includes('skill')) return 'skill';
  if (name.includes('plan')) return 'planning';
  if (name.includes('mcp')) return 'mcp';
  if (name.includes('askuser')) return 'utility';

  return 'other';
}

function inferRisk(category: ToolCapabilityCategory, readOnly: boolean, needsWorkspaceWrite: boolean): ToolCapabilityRisk {
  if (readOnly) return 'low';
  if (category === 'shell') return 'high';
  if (needsWorkspaceWrite) return 'medium';
  if (category === 'workspace' || category === 'configuration' || category === 'task') return 'medium';
  return 'medium';
}

function inferNeedsWorkspaceWrite(category: ToolCapabilityCategory, readOnly: boolean): boolean {
  if (readOnly) return false;
  return ['filesystem', 'shell', 'workspace', 'configuration', 'task', 'agent', 'planning'].includes(category);
}

function inferConcurrencySafe(tool: ToolDefinition, readOnly: boolean): boolean {
  const explicit = tool.isConcurrencySafe;
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  return readOnly ? true : false;
}

export function resolveToolCapability(tool: ToolDefinition): ResolvedToolCapability {
  const explicit = tool.capability;
  const builtin = BUILTIN_CAPABILITY_OVERRIDES[tool.name];
  const readOnly = typeof tool.isReadOnly === 'boolean'
    ? tool.isReadOnly
    : explicit?.readOnly ?? builtin?.readOnly ?? false;
  const category = explicit?.category ?? builtin?.category ?? inferCategoryFromName(tool);
  const needsWorkspaceWrite = explicit?.needsWorkspaceWrite ?? builtin?.needsWorkspaceWrite ?? inferNeedsWorkspaceWrite(category, readOnly);
  const concurrencySafe = explicit?.concurrencySafe ?? builtin?.concurrencySafe ?? inferConcurrencySafe(tool, readOnly);
  const risk = explicit?.risk ?? builtin?.risk ?? inferRisk(category, readOnly, needsWorkspaceWrite);

  return {
    category,
    tags: normalizeTags(explicit?.tags ?? builtin?.tags),
    risk,
    needsWorkspaceWrite,
    concurrencySafe,
    readOnly,
    source: explicit ? 'explicit' : 'derived',
  };
}

export function describeToolCapability(tool: ToolDefinition): ToolCapabilityExportEntry {
  return {
    name: tool.name,
    description: tool.description,
    capability: resolveToolCapability(tool),
  };
}

