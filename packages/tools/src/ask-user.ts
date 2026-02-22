import * as readline from 'readline/promises';
import type { ToolDefinition } from './types.js';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export function createAskUserTool(): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    description: 'Ask the user a question with multiple choice options',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(input: { questions: Question[] }, _ctx) {
      const answers: Record<string, string> = {};
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      try {
        for (const q of input.questions) {
          const prefix = q.header ? `[${q.header}] ` : '';
          console.log(`\n${prefix}${q.question}`);

          if (q.options && q.options.length > 0) {
            q.options.forEach((opt, i) => {
              console.log(`  ${i + 1}. ${opt.label} - ${opt.description}`);
            });
            console.log(`  ${q.options.length + 1}. Other (type your answer)`);
          }

          const answer = await rl.question('Your choice: ');
          const choiceNum = parseInt(answer, 10);

          if (
            q.options &&
            q.options.length > 0 &&
            choiceNum > 0 &&
            choiceNum <= q.options.length
          ) {
            answers[q.question] = q.options[choiceNum - 1].label;
          } else {
            answers[q.question] = answer;
          }
        }
      } finally {
        rl.close();
      }

      return {
        questions: input.questions,
        answers,
      };
    },
  };
}
