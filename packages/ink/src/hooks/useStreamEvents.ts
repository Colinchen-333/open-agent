import { useState, useCallback } from 'react';
import type { SDKMessage } from '@open-agent/core';

export function useStreamEvents() {
  const [messages, setMessages] = useState<SDKMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const consumeStream = useCallback(async (stream: AsyncGenerator<SDKMessage>) => {
    setIsStreaming(true);
    try {
      for await (const msg of stream) {
        setMessages(prev => [...prev, msg]);
      }
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, isStreaming, consumeStream, clearMessages };
}
