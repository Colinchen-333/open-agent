import { describe, it, expect } from 'bun:test';
import { createTaskTool } from '../task-tool.js';
import type { TaskToolDeps } from '../task-tool.js';
import type { ToolContext } from '../types.js';

const mockCtx: ToolContext = {
  cwd: '/tmp/test-project',
  sessionId: 'test-session-001',
};

// runSubagent is the boundary: it returns the fully-formatted result string
// (JSON for success, plain text for errors). The task-tool passes through whatever it returns.
function makeDeps(overrides?: Partial<TaskToolDeps>): TaskToolDeps {
  return {
    runSubagent: async params => {
      if (params.runInBackground) {
        const agentId = params.resume || 'agent-mock-bg-001';
        return JSON.stringify({
          agentId,
          output_file: `/tmp/open-agent/agents/${agentId}.output`,
          status: 'running',
          message: 'Agent is running in the background.',
        });
      }
      const agentId = params.resume || 'agent-mock-fg-001';
      return JSON.stringify({
        agentId,
        result: `result for: ${params.prompt}`,
        ...(params.isolation === 'worktree' ? { worktree_info: 'Agent ran in isolated worktree' } : {}),
      });
    },
    ...overrides,
  };
}

describe('Task tool', () => {
  describe('tool metadata', () => {
    it('has correct name', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.name).toBe('Task');
    });

    it('has a non-empty description', () => {
      const tool = createTaskTool(makeDeps());
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    });

    it('description mentions "agent" and "task"', () => {
      const tool = createTaskTool(makeDeps());
      const desc = tool.description.toLowerCase();
      expect(desc).toContain('agent');
      expect(desc).toContain('task');
    });
  });

  describe('inputSchema required fields', () => {
    it('requires description', () => {
      const tool = createTaskTool(makeDeps());
      const { required } = tool.inputSchema;
      expect(required).toContain('description');
    });

    it('requires prompt', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.required).toContain('prompt');
    });

    it('requires subagent_type', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.required).toContain('subagent_type');
    });

    it('description field is a string property', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.description.type).toBe('string');
    });

    it('prompt field is a string property', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.prompt.type).toBe('string');
    });

    it('subagent_type field is a string property', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.subagent_type.type).toBe('string');
    });
  });

  describe('inputSchema optional fields', () => {
    it('has isolation field', () => {
      const tool = createTaskTool(makeDeps());
      const { properties } = tool.inputSchema;
      expect(properties.isolation).toBeDefined();
      expect(properties.isolation.enum).toContain('worktree');
    });

    it('has run_in_background field as boolean', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.run_in_background.type).toBe('boolean');
    });

    it('has max_turns field as integer', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.max_turns.type).toBe('integer');
    });

    it('max_turns has exclusiveMinimum of 0', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.max_turns.exclusiveMinimum).toBe(0);
    });

    it('has mode field with valid enum values', () => {
      const tool = createTaskTool(makeDeps());
      const { mode } = tool.inputSchema.properties;
      expect(mode).toBeDefined();
      expect(mode.enum).toContain('acceptEdits');
      expect(mode.enum).toContain('bypassPermissions');
      expect(mode.enum).toContain('default');
      expect(mode.enum).toContain('dontAsk');
      expect(mode.enum).toContain('plan');
    });

    it('has model field with valid enum values', () => {
      const tool = createTaskTool(makeDeps());
      const { model } = tool.inputSchema.properties;
      expect(model).toBeDefined();
      expect(model.enum).toContain('sonnet');
      expect(model.enum).toContain('opus');
      expect(model.enum).toContain('haiku');
    });

    it('has name field', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.name).toBeDefined();
      expect(tool.inputSchema.properties.name.type).toBe('string');
    });

    it('has resume field', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.resume).toBeDefined();
      expect(tool.inputSchema.properties.resume.type).toBe('string');
    });

    it('has team_name field', () => {
      const tool = createTaskTool(makeDeps());
      expect(tool.inputSchema.properties.team_name).toBeDefined();
      expect(tool.inputSchema.properties.team_name.type).toBe('string');
    });
  });

  describe('execute() - calls runSubagent with correct params', () => {
    it('passes prompt to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: 'test', result: 'done' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        { description: 'test task', prompt: 'Do something specific', subagent_type: 'Explore' },
        mockCtx
      );

      expect(capturedParams.prompt).toBe('Do something specific');
    });

    it('passes subagentType to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: 'test', result: 'done' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        { description: 'explore task', prompt: 'Read the codebase', subagent_type: 'Explore' },
        mockCtx
      );

      expect(capturedParams.subagentType).toBe('Explore');
    });

    it('passes cwd from context to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: 'test', result: 'done' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        { description: 'cwd test', prompt: 'Check cwd', subagent_type: 'general-purpose' },
        mockCtx
      );

      expect(capturedParams.cwd).toBe('/tmp/test-project');
    });

    it('passes optional params (model, name, mode, max_turns, team_name)', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: 'test', result: 'done' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        {
          description: 'full options test',
          prompt: 'Do full task',
          subagent_type: 'code-writer',
          model: 'opus',
          name: 'my-subagent',
          mode: 'acceptEdits',
          max_turns: 5,
          team_name: 'alpha-team',
        },
        mockCtx
      );

      expect(capturedParams.model).toBe('opus');
      expect(capturedParams.name).toBe('my-subagent');
      expect(capturedParams.mode).toBe('acceptEdits');
      expect(capturedParams.maxTurns).toBe(5);
      expect(capturedParams.teamName).toBe('alpha-team');
    });

    it('passes isolation to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: 'test', result: 'done' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        {
          description: 'isolation test',
          prompt: 'Work in isolation',
          subagent_type: 'code-writer',
          isolation: 'worktree',
        },
        mockCtx
      );

      expect(capturedParams.isolation).toBe('worktree');
    });

    it('passes resume to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          return JSON.stringify({ agentId: params.resume, result: 'resumed' });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        {
          description: 'resume param test',
          prompt: 'Resume foreground',
          subagent_type: 'code-writer',
          resume: 'agent-existing-001',
        },
        mockCtx
      );

      expect(capturedParams.resume).toBe('agent-existing-001');
    });
  });

  describe('execute() - foreground mode', () => {
    it('returns result from runSubagent', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        { description: 'success test', prompt: 'Do the work', subagent_type: 'general-purpose' },
        mockCtx
      );

      // task-tool passes through the runSubagent result directly
      expect(typeof output).toBe('string');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('agentId');
      expect(parsed).toHaveProperty('result');
    });

    it('includes worktree_info when isolation is worktree (from runSubagent)', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        {
          description: 'worktree test',
          prompt: 'Work in isolation',
          subagent_type: 'code-writer',
          isolation: 'worktree',
        },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed.worktree_info).toBeDefined();
    });

    it('does not include worktree_info when isolation is not set', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        { description: 'no worktree test', prompt: 'Normal task', subagent_type: 'general-purpose' },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed.worktree_info).toBeUndefined();
    });

    it('returns error message string when runSubagent throws', async () => {
      const deps = makeDeps({
        runSubagent: async () => {
          throw new Error('subagent crashed');
        },
      });
      const tool = createTaskTool(deps);

      const output = await tool.execute(
        {
          description: 'failing task',
          prompt: 'Do something impossible',
          subagent_type: 'general-purpose',
        },
        mockCtx
      );

      expect(typeof output).toBe('string');
      expect(output).toContain('Error');
      expect(output).toContain('subagent crashed');
    });
  });

  describe('execute() - background mode', () => {
    it('passes run_in_background: true to runSubagent', async () => {
      let capturedParams: any;
      const deps = makeDeps({
        runSubagent: async params => {
          capturedParams = params;
          const agentId = 'agent-bg-test';
          return JSON.stringify({
            agentId,
            output_file: `/tmp/open-agent/agents/${agentId}.output`,
            status: 'running',
          });
        },
      });
      const tool = createTaskTool(deps);

      await tool.execute(
        {
          description: 'background task',
          prompt: 'Run in background',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        mockCtx
      );

      expect(capturedParams.runInBackground).toBe(true);
    });

    it('returns output_file path when run_in_background is true', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        {
          description: 'background task',
          prompt: 'Run in background',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('output_file');
      expect(typeof parsed.output_file).toBe('string');
      expect(parsed.output_file).toContain('.output');
    });

    it('returns status "running" for background tasks', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        {
          description: 'background status test',
          prompt: 'Run in background',
          subagent_type: 'Explore',
          run_in_background: true,
        },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('running');
    });

    it('returns agentId in background response', async () => {
      const tool = createTaskTool(makeDeps());

      const output = await tool.execute(
        {
          description: 'bg agentId test',
          prompt: 'Background task',
          subagent_type: 'Explore',
          run_in_background: true,
        },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('agentId');
      expect(typeof parsed.agentId).toBe('string');
    });

    it('uses resume ID when provided', async () => {
      const tool = createTaskTool(makeDeps());
      const resumeId = 'agent-resume-bg-xyz';

      const output = await tool.execute(
        {
          description: 'resume bg test',
          prompt: 'Resume background task',
          subagent_type: 'general-purpose',
          run_in_background: true,
          resume: resumeId,
        },
        mockCtx
      );

      const parsed = JSON.parse(output);
      expect(parsed.agentId).toBe(resumeId);
    });
  });
});
