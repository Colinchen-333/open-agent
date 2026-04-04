import React, { useCallback } from 'react';
import { Box } from 'ink';
import { MessageList } from './MessageList.js';
import { CostBar } from './CostBar.js';
import { Spinner } from './Spinner.js';
import { PromptInput } from './PromptInput.js';
import { useStore } from '../hooks/useStore.js';
import { useStreamEvents } from '../hooks/useStreamEvents.js';
import type { ConversationLoop } from '@open-agent/core';
import type { AppState } from '@open-agent/state';

interface REPLProps {
  loop: ConversationLoop;
}

export function REPL({ loop }: REPLProps) {
  const usage = useStore<AppState, AppState['totalUsage']>(s => s.totalUsage);
  const { messages, isStreaming, consumeStream } = useStreamEvents();

  const handleSubmit = useCallback(async (text: string) => {
    const stream = loop.run(text);
    await consumeStream(stream);
  }, [loop, consumeStream]);

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      {isStreaming && <Spinner label="Thinking" />}
      <CostBar
        inputTokens={usage.inputTokens}
        outputTokens={usage.outputTokens}
        costUsd={usage.costUsd}
      />
      <PromptInput onSubmit={handleSubmit} isDisabled={isStreaming} />
    </Box>
  );
}
