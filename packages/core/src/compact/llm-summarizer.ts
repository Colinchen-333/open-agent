import type { MessageSummarizer, SummarizerOptions } from './summarizer.js';
import type { LLMProvider } from '@open-agent/providers';

/**
 * A MessageSummarizer backed by an LLM provider. Formats the messages into
 * a text prompt and asks the model to produce a concise digest.
 */
export function createLLMSummarizer(provider: LLMProvider, model: string): MessageSummarizer {
  return {
    async summarize(messages: ReadonlyArray<unknown>, options?: SummarizerOptions): Promise<string> {
      const maxTokens = options?.maxTokens ?? 1000;
      const style = options?.style ?? 'brief';

      // Format messages into a readable transcript
      const transcript = (messages as any[])
        .map((m) => {
          const role = m.role ?? 'unknown';
          let content = '';
          if (typeof m.content === 'string') {
            content = m.content.slice(0, 500);
          } else if (Array.isArray(m.content)) {
            content = m.content
              .map((b: any) => {
                if (b.type === 'text') return (b.text ?? '').slice(0, 300);
                if (b.type === 'tool_use') return `[tool_use: ${b.name}(${JSON.stringify(b.input).slice(0, 100)})]`;
                if (b.type === 'tool_result') return `[tool_result: ${(typeof b.content === 'string' ? b.content : '...').slice(0, 200)}]`;
                return `[${b.type}]`;
              })
              .join(' ');
          }
          return `${role}: ${content}`;
        })
        .join('\n');

      const promptText = style === 'brief'
        ? `Summarize this conversation in ${maxTokens} tokens or less. Preserve: key decisions, file paths, errors found, and next steps.\n\n${transcript.slice(0, 15000)}`
        : `Provide a detailed summary of this conversation. Include: all files modified, commands run, decisions made, and remaining tasks.\n\n${transcript.slice(0, 20000)}`;

      try {
        // Call the provider using the standard chat interface
        let result = '';
        const stream = provider.chat(
          [{ role: 'user', content: promptText }],
          {
            model,
            systemPrompt: 'You are a conversation summarizer. Output ONLY the summary, no preamble.',
            maxTokens,
            signal: options?.signal,
          },
        );

        for await (const event of stream) {
          if (event.type === 'text_delta') {
            result += event.text;
          }
        }

        return result.trim() || `[${messages.length} messages compacted — summarizer returned empty]`;
      } catch (e) {
        // Fallback on any error — compact must never crash the conversation loop
        return `[${messages.length} messages compacted — summarizer error: ${(e as Error).message?.slice(0, 100)}]`;
      }
    },
  };
}
