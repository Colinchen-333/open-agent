import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';

interface PromptInputProps {
  onSubmit: (text: string) => void;
  isDisabled?: boolean;
}

export function PromptInput({ onSubmit, isDisabled }: PromptInputProps) {
  const [input, setInput] = useState('');

  useInput((char, key) => {
    if (isDisabled) return;
    if (key.return) {
      if (input.trim()) {
        onSubmit(input.trim());
        setInput('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput(prev => prev + char);
    }
  });

  return (
    <Box>
      <Text color="green" bold>{'> '}</Text>
      <Text>{input}</Text>
      {!isDisabled && <Text color="gray">█</Text>}
    </Box>
  );
}
