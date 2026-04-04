export type CapabilityGroup =
  | 'files'
  | 'execution'
  | 'coordination'
  | 'integration'
  | 'external'
  | 'utility';

export type CapabilityAccess = 'read-only' | 'mutable' | 'meta' | 'external';

export interface CapabilityProfile {
  toolName: string;
  description: string;
  group: CapabilityGroup;
  access: CapabilityAccess;
  readOnly?: boolean;
  concurrencySafe?: boolean;
  risk?: 'low' | 'medium' | 'high';
  needsWorkspaceWrite?: boolean;
  source: 'builtin' | 'dynamic' | 'mcp';
  tags: string[];
}

export interface CapabilityPreset {
  name: CapabilityGroup;
  description: string;
  toolNames: string[];
  toolCount: number;
}

export interface CapabilitySnapshot {
  totalTools: number;
  profiles: CapabilityProfile[];
  presets: CapabilityPreset[];
  summary: {
    accessCounts: Record<CapabilityAccess, number>;
    groupCounts: Record<CapabilityGroup, number>;
    mcpTools: number;
    dynamicTools: number;
  };
}

const FILE_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
]);

const EXECUTION_TOOL_NAMES = new Set([
  'Bash',
  'EnterWorktree',
  'Config',
]);

const COORDINATION_TOOL_NAMES = new Set([
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

const INTEGRATION_TOOL_NAMES = new Set([
  'Skill',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

const EXTERNAL_TOOL_NAMES = new Set([
  'WebSearch',
  'WebFetch',
]);

const MUTABLE_TOOL_NAMES = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'EnterWorktree',
  'Config',
  'TaskCreate',
  'TaskUpdate',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
]);

const CAPABILITY_GROUP_DESCRIPTIONS: Record<CapabilityGroup, string> = {
  files: 'Filesystem inspection and editing tools.',
  execution: 'Local execution and workspace-control tools.',
  coordination: 'Agent orchestration, task, and planning tools.',
  integration: 'Skills, tool discovery, and MCP integration tools.',
  external: 'Network-facing tools.',
  utility: 'General-purpose tools that do not fit another group.',
};

function hasMcpPrefix(name: string): boolean {
  return name.startsWith('mcp__');
}

function determineGroup(name: string): CapabilityGroup {
  if (FILE_TOOL_NAMES.has(name)) return 'files';
  if (EXECUTION_TOOL_NAMES.has(name)) return 'execution';
  if (COORDINATION_TOOL_NAMES.has(name)) return 'coordination';
  if (INTEGRATION_TOOL_NAMES.has(name) || hasMcpPrefix(name)) return 'integration';
  if (EXTERNAL_TOOL_NAMES.has(name)) return 'external';
  return 'utility';
}

function determineAccess(name: string, group: CapabilityGroup): CapabilityAccess {
  if (hasMcpPrefix(name) || group === 'external') return 'external';
  if (MUTABLE_TOOL_NAMES.has(name)) return 'mutable';
  if (name === 'Skill' || name === 'ToolSearch' || name === 'Config' || group === 'integration') {
    return 'meta';
  }
  if (group === 'coordination') return 'meta';
  if (group === 'execution') return 'mutable';
  if (group === 'files' || group === 'utility') return 'read-only';
  return 'read-only';
}

function determineSource(name: string): 'builtin' | 'dynamic' | 'mcp' {
  if (hasMcpPrefix(name) || name === 'ListMcpResourcesTool' || name === 'ReadMcpResourceTool') {
    return 'mcp';
  }
  if (name === 'ToolSearch') {
    return 'dynamic';
  }
  return 'builtin';
}

export function buildCapabilitySnapshotFromTools(toolNames: string[]): CapabilitySnapshot {
  const profiles = [...new Set(toolNames)]
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .map((toolName) => {
      const group = determineGroup(toolName);
      const access = determineAccess(toolName, group);
      const source = determineSource(toolName);
      const tags = [group, access];
      if (source === 'mcp') tags.push('mcp');
      if (source === 'dynamic') tags.push('dynamic');
      if (group === 'execution') tags.push('workspace');
      if (group === 'coordination') tags.push('orchestration');
      if (group === 'external') tags.push('network');
      if (FILE_TOOL_NAMES.has(toolName)) tags.push('files');
      return {
        toolName,
        description: toolName,
        group,
        access,
        readOnly: access === 'read-only',
        concurrencySafe: access !== 'mutable',
        risk: access === 'external' ? 'low' : access === 'mutable' ? 'medium' : 'low',
        needsWorkspaceWrite: access === 'mutable',
        source,
        tags: [...new Set(tags)],
      };
    })
    .sort((left, right) =>
      left.group.localeCompare(right.group) || left.toolName.localeCompare(right.toolName));

  const presets = (Object.keys(CAPABILITY_GROUP_DESCRIPTIONS) as CapabilityGroup[])
    .map((group) => {
      const toolNamesInGroup = profiles
        .filter((profile) => profile.group === group)
        .map((profile) => profile.toolName)
        .sort((left, right) => left.localeCompare(right));

      return {
        name: group,
        description: CAPABILITY_GROUP_DESCRIPTIONS[group],
        toolNames: toolNamesInGroup,
        toolCount: toolNamesInGroup.length,
      };
    })
    .filter((preset) => preset.toolCount > 0);

  const summary = profiles.reduce<CapabilitySnapshot['summary']>((acc, profile) => {
    acc.accessCounts[profile.access] += 1;
    acc.groupCounts[profile.group] += 1;
    if (profile.source === 'mcp') acc.mcpTools += 1;
    if (profile.source === 'dynamic') acc.dynamicTools += 1;
    return acc;
  }, {
    accessCounts: {
      'read-only': 0,
      mutable: 0,
      meta: 0,
      external: 0,
    },
    groupCounts: {
      files: 0,
      execution: 0,
      coordination: 0,
      integration: 0,
      external: 0,
      utility: 0,
    },
    mcpTools: 0,
    dynamicTools: 0,
  });

  return {
    totalTools: profiles.length,
    profiles,
    presets,
    summary,
  };
}

function formatList(items: string[], limit = 8): string {
  if (items.length === 0) return '(none)';
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} … (+${items.length - limit} more)`;
}

export function formatCapabilitySnapshotForDisplay(snapshot: CapabilitySnapshot): string {
  const workspaceWriteCount = snapshot.profiles.filter((profile) => profile.needsWorkspaceWrite).length;
  const highRiskCount = snapshot.profiles.filter((profile) => profile.risk === 'high').length;
  const lines = [
    'Capability snapshot:',
    `  Total tools: ${snapshot.totalTools}`,
    `  Read-only:   ${snapshot.summary.accessCounts['read-only']}`,
    `  Mutable:     ${snapshot.summary.accessCounts.mutable}`,
    `  Meta:        ${snapshot.summary.accessCounts.meta}`,
    `  External:    ${snapshot.summary.accessCounts.external}`,
    `  Workspace write: ${workspaceWriteCount}`,
    `  High risk:   ${highRiskCount}`,
    `  MCP tools:   ${snapshot.summary.mcpTools}`,
    `  Dynamic:     ${snapshot.summary.dynamicTools}`,
    '',
    'Capability presets:',
  ];

  for (const preset of snapshot.presets) {
    lines.push(`  - ${preset.name} (${preset.toolCount})`);
    lines.push(`    ${preset.description}`);
    lines.push(`    Tools: ${formatList(preset.toolNames)}`);
  }

  const groupedProfiles = snapshot.profiles.reduce<Record<CapabilityGroup, string[]>>((acc, profile) => {
    acc[profile.group].push(profile.toolName);
    return acc;
  }, {
    files: [],
    execution: [],
    coordination: [],
    integration: [],
    external: [],
    utility: [],
  });

  lines.push('');
  lines.push('Capability profile groups:');
  for (const group of Object.keys(groupedProfiles) as CapabilityGroup[]) {
    const tools = groupedProfiles[group];
    if (tools.length === 0) continue;
    lines.push(`  ${group.padEnd(13)} ${tools.length.toString().padStart(2)}  ${formatList(tools, 10)}`);
  }

  return lines.join('\n');
}

export function serializeCapabilitySnapshot(snapshot: CapabilitySnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
