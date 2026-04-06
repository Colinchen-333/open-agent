import { describe, expect, test } from 'bun:test';
import type {
  PermissionDecisionClassification,
  PermissionUpdateTarget,
  ThinkingAdaptive,
  PromptRequest,
  PromptResponse,
  EffortLevel,
  FastModeState,
  CronTask,
  CronJitterConfig,
  ScheduledTaskEvent,
  InboundPrompt,
  ConnectRemoteControlOptions,
  RemoteControlHandle,
  SandboxIgnoreViolations,
  JsonSchemaOutputFormat,
  OutputFormat,
  SlashCommandInfo,
  SdkPluginConfig,
  SdkBeta,
  BaseOutputFormat,
  PromptRequestOption,
  ScheduledTasksHandle,
} from '../sdk-types-complete';

describe('SDK complete types', () => {
  test('PermissionDecisionClassification values', () => {
    const c: PermissionDecisionClassification = 'auto_approved_safe_tool';
    expect(c).toBe('auto_approved_safe_tool');
  });

  test('PermissionUpdateTarget values', () => {
    const t: PermissionUpdateTarget = 'session';
    expect(t).toBe('session');
  });

  test('ThinkingAdaptive shape', () => {
    const t: ThinkingAdaptive = { type: 'adaptive', budgetTokens: 5000 };
    expect(t.type).toBe('adaptive');
  });

  test('OutputFormat union — text', () => {
    const text: OutputFormat = { type: 'text' };
    expect(text.type).toBe('text');
  });

  test('OutputFormat union — json_schema', () => {
    const schema: OutputFormat = { type: 'json_schema', name: 'test', schema: {} };
    expect((schema as JsonSchemaOutputFormat).name).toBe('test');
  });

  test('BaseOutputFormat stream-json', () => {
    const fmt: BaseOutputFormat = { type: 'stream-json' };
    expect(fmt.type).toBe('stream-json');
  });

  test('PromptRequest + Response shape', () => {
    const req: PromptRequest = { id: 'p1', message: 'Allow?', type: 'confirm' };
    const res: PromptResponse = { id: 'p1', value: 'yes', cancelled: false };
    expect(req.type).toBe('confirm');
    expect(res.cancelled).toBe(false);
  });

  test('PromptRequestOption shape', () => {
    const opt: PromptRequestOption = { label: 'Yes', value: 'yes' };
    expect(opt.label).toBe('Yes');
  });

  test('EffortLevel values', () => {
    const levels: EffortLevel[] = ['low', 'medium', 'high', 'max'];
    expect(levels).toHaveLength(4);
  });

  test('FastModeState values', () => {
    const states: FastModeState[] = ['enabled', 'disabled', 'auto'];
    expect(states).toHaveLength(3);
  });

  test('SdkBeta is a string alias', () => {
    const beta: SdkBeta = 'extended-thinking-v2';
    expect(typeof beta).toBe('string');
  });

  test('SdkPluginConfig shape', () => {
    const p: SdkPluginConfig = { name: 'my-plugin', path: '/opt/plugins/my', enabled: true };
    expect(p.name).toBe('my-plugin');
  });

  test('CronTask shape', () => {
    const t: CronTask = { id: 'c1', cron: '*/5 * * * *', prompt: 'check status', createdAt: Date.now() };
    expect(t.cron).toBe('*/5 * * * *');
  });

  test('CronJitterConfig shape', () => {
    const j: CronJitterConfig = {
      recurringFrac: 0.1,
      recurringCapMs: 30_000,
      oneShotMaxMs: 60_000,
      oneShotFloorMs: 1_000,
      oneShotMinuteMod: 5,
      recurringMaxAgeMs: 86_400_000,
    };
    expect(j.recurringFrac).toBe(0.1);
  });

  test('ScheduledTaskEvent discriminated union', () => {
    const fire: ScheduledTaskEvent = {
      type: 'fire',
      task: { id: 'c1', cron: '*', prompt: 'x', createdAt: 0 },
    };
    const missed: ScheduledTaskEvent = { type: 'missed', tasks: [] };
    expect(fire.type).toBe('fire');
    expect(missed.type).toBe('missed');
  });

  test('ScheduledTasksHandle shape', () => {
    // Just verify the interface compiles with a mock
    const handle: ScheduledTasksHandle = {
      events: async function* () {},
      getNextFireTime: () => null,
    };
    expect(handle.getNextFireTime()).toBeNull();
  });

  test('SandboxIgnoreViolations shape', () => {
    const s: SandboxIgnoreViolations = { patterns: ['*.tmp'], ignoreAll: false };
    expect(s.patterns).toHaveLength(1);
  });

  test('SlashCommandInfo shape', () => {
    const c: SlashCommandInfo = { name: 'doctor', description: 'Run diagnostics' };
    expect(c.name).toBe('doctor');
  });

  test('InboundPrompt shape', () => {
    const p: InboundPrompt = { content: 'hello', uuid: 'abc-123' };
    expect(p.content).toBe('hello');
  });

  test('ConnectRemoteControlOptions shape', () => {
    const opts: ConnectRemoteControlOptions = {
      dir: '/work',
      getAccessToken: () => 'token',
      baseUrl: 'https://api.claude.ai',
      orgUUID: 'org-1',
      model: 'sonnet',
    };
    expect(opts.baseUrl).toContain('claude');
  });

  test('RemoteControlHandle shape compiles', () => {
    // Verify the interface is structurally sound via a partial mock
    const partial: Pick<RemoteControlHandle, 'sessionUrl' | 'environmentId' | 'bridgeSessionId'> = {
      sessionUrl: 'https://claude.ai/session/1',
      environmentId: 'env-1',
      bridgeSessionId: 'bridge-1',
    };
    expect(partial.sessionUrl).toContain('claude');
  });
});
