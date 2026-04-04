import React from 'react';
import { Text, Box } from 'ink';
import type { SDKMessage } from '@open-agent/core';

interface MessageListProps {
  messages: SDKMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
    </Box>
  );
}

function MessageItem({ message }: { message: SDKMessage }) {
  switch (message.type) {
    case 'assistant': {
      const content = message.message?.content;
      const text = Array.isArray(content)
        ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        : typeof content === 'string' ? content : '';
      if (!text) return null;
      return (
        <Box>
          <Text color="blue" bold>Assistant: </Text>
          <Text>{text}</Text>
        </Box>
      );
    }
    case 'tool_result': {
      const icon = message.is_error ? '✗' : '✓';
      const color = message.is_error ? 'red' : 'green';
      return (
        <Box>
          <Text color={color}>{icon} </Text>
          <Text bold>{message.tool_name}</Text>
          <Text dimColor> {String(message.result ?? '').slice(0, 200)}</Text>
        </Box>
      );
    }
    default:
      return null;
  }
}
