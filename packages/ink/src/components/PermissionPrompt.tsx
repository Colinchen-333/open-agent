import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';

interface PermissionPromptProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  onDecision: (decision: 'allow' | 'deny' | 'always') => void;
}

export function PermissionPrompt({ toolName, toolInput, onDecision }: PermissionPromptProps) {
  const [selected, setSelected] = useState(0);
  const options = [
    { key: 'y', label: 'Allow once', value: 'allow' as const },
    { key: 'n', label: 'Deny', value: 'deny' as const },
    { key: 'a', label: 'Always allow', value: 'always' as const },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(options.length - 1, s + 1));
    if (key.return) onDecision(options[selected].value);
    if (input === 'y') onDecision('allow');
    if (input === 'n') onDecision('deny');
    if (input === 'a') onDecision('always');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission Required</Text>
      <Text>Tool: <Text bold>{toolName}</Text></Text>
      <Text dimColor>{JSON.stringify(toolInput).slice(0, 200)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.key}>
            {i === selected ? <Text color="cyan">{'> '}</Text> : '  '}
            <Text bold={i === selected}>[{opt.key}] {opt.label}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
