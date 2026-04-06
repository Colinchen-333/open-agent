import type { PermissionChecker, PermissionPrompter, SettingSource } from '@open-agent/core';
import { randomUUID } from 'crypto';
import {
  BASH_SANDBOX_BYPASS_APPROVED_FIELD,
  BASH_SANDBOX_POLICY_FIELD,
  buildBashSandboxPolicy,
  PermissionEngine,
  type SettingsChangeSource,
  SettingsChangeDetector,
  SettingsLoader,
  type BashSandboxExecutionPolicy,
  type PermissionRule,
  type SettingsFile,
} from '@open-agent/permissions';

export interface ApplyCliPermissionSettingsInput {
  permissionEngine: PermissionEngine;
  settings: Record<string, unknown> | null | undefined;
  cwd: string;
  additionalDirectories?: string[];
  permissionPromptToolName?: string;
}

export interface CreateCliPermissionCheckerInput {
  getPermissionEngine(): PermissionEngine;
  cwd: string;
}

type CliSessionPermissionUpdate =
  | {
    type: 'addRule';
    behavior: 'allow' | 'deny' | 'ask';
    rule: PermissionRule;
  }
  | {
    type: 'removeRule';
    behavior: 'allow' | 'deny' | 'ask';
    rule: PermissionRule;
  }
  | {
    type: 'setMode';
    mode: Parameters<PermissionEngine['setMode']>[0];
  };

export interface CliPermissionRuntime {
  permissionEngine: PermissionChecker & {
    removeRule(behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }): void;
    setMode(mode: string): void;
    getSummary(): ReturnType<PermissionEngine['getSummary']>;
    getPermissionPromptToolName(): string | undefined;
    setHookExecutor(executor: Parameters<PermissionEngine['setHookExecutor']>[0]): void;
    setLLMProvider(provider: Parameters<PermissionEngine['setLLMProvider']>[0]): void;
    setRecentUserMessages(messages: string[]): void;
  };
  rawPermissionEngine: PermissionEngine;
  refreshFromSettings(): SettingsFile;
  watchSettings(
    sources?: SettingSource[],
    options?: {
      onRefresh?(settings: SettingsFile, source: SettingsChangeSource): void;
    },
  ): { close(): void };
}

export interface CreateCliPermissionRuntimeInput {
  cwd: string;
  mode: Parameters<PermissionEngine['setMode']>[0];
  additionalDirectories?: string[];
  permissionPromptToolName?: string;
  settingsLoader?: SettingsLoader;
  settingsChangeDetector?: SettingsChangeDetector;
}

export function applyCliPermissionSettings({
  permissionEngine,
  settings,
  cwd,
  additionalDirectories = [],
  permissionPromptToolName,
}: ApplyCliPermissionSettingsInput): void {
  permissionEngine.replaceFromSettings(settings ?? undefined);

  if (additionalDirectories.length > 0) {
    const currentAllowed = permissionEngine.getSummary().allowedPaths;
    const base = currentAllowed.length > 0 ? currentAllowed : [cwd];
    permissionEngine.setAllowedPaths([...new Set([...base, ...additionalDirectories])]);
  }

  if (permissionPromptToolName) {
    permissionEngine.setPermissionPromptToolName(permissionPromptToolName);
  }
}

export function createCliPermissionChecker({
  getPermissionEngine,
  cwd,
}: CreateCliPermissionCheckerInput): PermissionChecker {
  const attachBashSandboxPolicy = (
    request: {
      toolName: string;
      input: unknown;
    },
    permissionBehavior?: 'allow' | 'deny' | 'ask',
  ): void => {
    if (request.toolName !== 'Bash') return;
    if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) return;

    const input = request.input as Record<string, unknown>;
    const permissionEngine = getPermissionEngine();
    const permissionSummary = permissionEngine.getSummary();
    input[BASH_SANDBOX_POLICY_FIELD] = buildBashSandboxPolicy({
      sandbox: permissionEngine.getSandboxConfig(),
      cwd,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
      bypassApproved: input[BASH_SANDBOX_BYPASS_APPROVED_FIELD] === true,
      permissionBehavior,
      runtimeAllowedPaths: permissionSummary.allowedPaths,
      runtimeDeniedPaths: permissionSummary.deniedPaths,
    });
  };

  return {
    evaluate: async (request) => {
      const permissionEngine = getPermissionEngine();
      const decision = await permissionEngine.evaluate({
        ...request,
        toolUseId: request.toolUseId ?? randomUUID(),
      } as any);
      attachBashSandboxPolicy(request, decision.behavior);
      return decision;
    },
    addRule: (behavior, rule) => getPermissionEngine().addRule(behavior, rule),
  };
}

export function wrapCliPermissionPrompter(
  prompter: PermissionPrompter,
): PermissionPrompter {
  return {
    prompt: async (request) => {
      const userDecision = await prompter.prompt(request);
      if (userDecision !== 'deny' && request.toolName === 'Bash') {
        const input = request.input as Record<string, unknown> | undefined;
        const maybePolicy = input?.[BASH_SANDBOX_POLICY_FIELD];
        if (
          maybePolicy &&
          typeof maybePolicy === 'object' &&
          (maybePolicy as BashSandboxExecutionPolicy).bypassRequested === true
        ) {
          (maybePolicy as BashSandboxExecutionPolicy).bypassAllowed = true;
          if (input) {
            input[BASH_SANDBOX_BYPASS_APPROVED_FIELD] = true;
          }
        }
      }
      return userDecision;
    },
  };
}

export function createCliPermissionRuntime({
  cwd,
  mode,
  additionalDirectories = [],
  permissionPromptToolName,
  settingsLoader = new SettingsLoader(),
  settingsChangeDetector = new SettingsChangeDetector(settingsLoader),
}: CreateCliPermissionRuntimeInput): CliPermissionRuntime {
  let currentMode = mode;
  let rawPermissionEngine = new PermissionEngine({ mode: currentMode });
  const sessionPermissionUpdates: CliSessionPermissionUpdate[] = [];

  // Stored so they can be re-applied whenever refreshFromSettings() rebuilds
  // the underlying PermissionEngine instance.
  let storedHookExecutor: Parameters<PermissionEngine['setHookExecutor']>[0] | undefined;
  let storedLLMProvider: Parameters<PermissionEngine['setLLMProvider']>[0] | undefined;

  const getPermissionEngine = (): PermissionEngine => rawPermissionEngine;

  const replaySessionPermissionUpdates = (engine: PermissionEngine): void => {
    for (const update of sessionPermissionUpdates) {
      if (update.type === 'addRule') {
        engine.addRule(update.behavior, { ...update.rule });
        continue;
      }
      if (update.type === 'removeRule') {
        engine.removeRule(update.behavior, { ...update.rule });
        continue;
      }
      engine.setMode(update.mode);
    }
  };

  /** Re-wire hookExecutor/llmProvider onto a freshly built engine. */
  const reapplyRuntimeDependencies = (engine: PermissionEngine): void => {
    if (storedHookExecutor) engine.setHookExecutor(storedHookExecutor);
    if (storedLLMProvider) engine.setLLMProvider(storedLLMProvider);
  };

  const refreshFromSettings = (): SettingsFile => {
    const settings = settingsLoader.load(cwd);
    const nextEngine = new PermissionEngine({ mode: currentMode });
    applyCliPermissionSettings({
      permissionEngine: nextEngine,
      settings,
      cwd,
      additionalDirectories,
      permissionPromptToolName,
    });
    replaySessionPermissionUpdates(nextEngine);
    reapplyRuntimeDependencies(nextEngine);
    currentMode = nextEngine.getMode();
    rawPermissionEngine = nextEngine;
    return settings;
  };

  refreshFromSettings();

  return {
    permissionEngine: {
      ...createCliPermissionChecker({ getPermissionEngine, cwd }),
      addRule: (behavior, rule) => {
        sessionPermissionUpdates.push({
          type: 'addRule',
          behavior,
          rule: { ...rule },
        });
        rawPermissionEngine.addRule(behavior, rule);
      },
      removeRule: (behavior, rule) => {
        sessionPermissionUpdates.push({
          type: 'removeRule',
          behavior,
          rule: { ...rule },
        });
        rawPermissionEngine.removeRule(behavior, rule);
      },
      setMode: (nextMode) => {
        const typedMode = nextMode as Parameters<PermissionEngine['setMode']>[0];
        currentMode = typedMode;
        sessionPermissionUpdates.push({
          type: 'setMode',
          mode: typedMode,
        });
        rawPermissionEngine.setMode(typedMode);
      },
      getSummary: () => rawPermissionEngine.getSummary(),
      getPermissionPromptToolName: () => rawPermissionEngine.getPermissionPromptToolName(),
      setHookExecutor: (executor: Parameters<PermissionEngine['setHookExecutor']>[0]) => {
        storedHookExecutor = executor;
        rawPermissionEngine.setHookExecutor(executor);
      },
      setLLMProvider: (provider: Parameters<PermissionEngine['setLLMProvider']>[0]) => {
        storedLLMProvider = provider;
        rawPermissionEngine.setLLMProvider(provider);
      },
      setRecentUserMessages: (messages: string[]) => {
        rawPermissionEngine.setRecentUserMessages(messages);
      },
    },
    get rawPermissionEngine() {
      return rawPermissionEngine;
    },
    refreshFromSettings,
    watchSettings(
      sources: SettingSource[] = ['user', 'project', 'local'],
      options?: {
        onRefresh?(settings: SettingsFile, source: SettingsChangeSource): void;
      },
    ): { close(): void } {
      const unsubscribe = settingsChangeDetector.subscribe((source) => {
        const nextSettings = refreshFromSettings();
        options?.onRefresh?.(nextSettings, source);
      });
      const watcher = settingsChangeDetector.watch(cwd, sources);
      return {
        close(): void {
          unsubscribe();
          watcher.close();
        },
      };
    },
  };
}
