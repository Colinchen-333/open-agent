import * as readline from 'readline/promises';
import type { ToolDefinition } from './types.js';

interface QuestionOptionInput {
  label: string;
  description: string;
  markdown?: string;
}

interface QuestionInput {
  question: string;
  header: string;
  options: QuestionOptionInput[];
  multiSelect: boolean;
}

interface AnnotationValue {
  markdown?: string;
  notes?: string;
}

interface AskUserInput {
  questions: QuestionInput[];
  annotations?: Record<string, AnnotationValue>;
  metadata?: { source?: string };
}

function renderMarkdownBox(content: string): void {
  const lines = content.split('\n');
  const width = Math.max(...lines.map(l => l.length), 40);
  const border = '─'.repeat(width + 2);
  console.log(`  ┌${border}┐`);
  for (const line of lines) {
    console.log(`  │ ${line.padEnd(width)} │`);
  }
  console.log(`  └${border}┘`);
}

export function createAskUserTool(): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    description: 'Ask the user one or more questions with structured multiple-choice options',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user (1-4 questions)',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The complete question to ask the user.' },
              header: { type: 'string', description: 'Very short label displayed as a chip/tag (max 12 chars).' },
              options: {
                type: 'array',
                description: 'The available choices (2-4 options). An "Other" option is auto-added.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Display text for the option (1-5 words).' },
                    description: { type: 'string', description: 'Explanation of what this option means.' },
                    markdown: { type: 'string', description: 'Optional preview content shown in monospace box.' },
                  },
                  required: ['label', 'description'],
                },
                minItems: 2,
                maxItems: 4,
              },
              multiSelect: { type: 'boolean', default: false, description: 'Allow multiple selections.' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
          minItems: 1,
          maxItems: 4,
        },
        annotations: {
          type: 'object',
          description: 'Optional per-question annotations from the user.',
          additionalProperties: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              notes: { type: 'string' },
            },
          },
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata for tracking.',
          properties: {
            source: { type: 'string' },
          },
        },
      },
      required: ['questions'],
    },
    async execute(input: AskUserInput, _ctx) {
      const answers: Record<string, string | string[]> = {};
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      try {
        for (const q of input.questions) {
          // Print header tag + question
          console.log(`\n[${q.header}] ${q.question}`);

          // Print options
          q.options.forEach((opt, i) => {
            const checkbox = q.multiSelect ? '[ ] ' : '';
            console.log(`  ${i + 1}. ${checkbox}${opt.label} — ${opt.description}`);
            if (opt.markdown) {
              renderMarkdownBox(opt.markdown);
            }
          });

          // Auto-add "Other" option
          const otherIndex = q.options.length + 1;
          console.log(`  ${otherIndex}. Other (type your answer)`);

          if (q.multiSelect) {
            console.log('  (Enter comma-separated numbers, e.g. 1,2)');
            const answer = await rl.question('Your choices: ');
            const parts = answer.split(',').map(s => s.trim());
            const selected: string[] = [];

            for (const part of parts) {
              const choiceNum = parseInt(part, 10);
              if (!isNaN(choiceNum) && choiceNum > 0 && choiceNum <= q.options.length) {
                selected.push(q.options[choiceNum - 1].label);
              } else if (choiceNum === otherIndex) {
                const freeText = await rl.question('Please specify: ');
                selected.push(freeText.trim());
              } else if (part) {
                selected.push(part);
              }
            }

            answers[q.question] = selected;
          } else {
            const answer = await rl.question('Your choice: ');
            const choiceNum = parseInt(answer, 10);

            if (!isNaN(choiceNum) && choiceNum > 0 && choiceNum <= q.options.length) {
              answers[q.question] = q.options[choiceNum - 1].label;
            } else if (choiceNum === otherIndex) {
              const freeText = await rl.question('Please specify: ');
              answers[q.question] = freeText.trim();
            } else {
              answers[q.question] = answer.trim();
            }
          }
        }
      } finally {
        rl.close();
      }

      return {
        questions: input.questions,
        answers,
        ...(input.annotations ? { annotations: input.annotations } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
    },
  };
}
