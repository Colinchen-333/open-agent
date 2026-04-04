import React from 'react';
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';

const TOOL_ICONS: Record<string, string> = {
  Read: '📄', Write: '✏️', Edit: '✏️', Bash: '⚡',
  Glob: '🔍', Grep: '🔍', WebSearch: '🌐', WebFetch: '🌐',
};

interface ToolProgressProps {
  toolName: string;
  toolInput?: Record<string, unknown>;
  isExecuting: boolean;
}

export function ToolProgress({ toolName, toolInput, isExecuting }: ToolProgressProps) {
  const icon = TOOL_ICONS[toolName] ?? '🔧';
  const label = getLabel(toolName, toolInput);

  if (isExecuting) {
    return (
      <Box>
        <Text>{icon} </Text>
        <Spinner label={label} />
      </Box>
    );
  }

  return (
    <Box>
      <Text>{icon} </Text>
      <Text bold>{toolName}</Text>
    </Box>
  );
}

function getLabel(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName;
  switch (toolName) {
    case 'Read': return `Reading ${input.file_path ?? ''}`;
    case 'Write': return `Writing ${input.file_path ?? ''}`;
    case 'Edit': return `Editing ${input.file_path ?? ''}`;
    case 'Bash': return `Running ${String(input.command ?? '').slice(0, 60)}`;
    case 'Glob': return `Searching ${input.pattern ?? ''}`;
    case 'Grep': return `Grepping ${input.pattern ?? ''}`;
    default: return toolName;
  }
}
