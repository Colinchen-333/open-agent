import React from 'react';
import { Text, Box } from 'ink';

interface CostBarProps {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function CostBar({ inputTokens, outputTokens, costUsd }: CostBarProps) {
  return (
    <Box>
      <Text dimColor>
        Tokens: <Text color="green">{inputTokens}</Text>
        {' '}in / <Text color="yellow">{outputTokens}</Text>
        {' '}out · ${costUsd.toFixed(4)}
      </Text>
    </Box>
  );
}
