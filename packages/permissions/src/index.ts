// @open-agent/permissions - Permission system
// Handles tool use approval, deny rules, and permission modes

export type { PermissionMode, PermissionBehavior } from '@open-agent/core';
export * from './types';
export * from './bash-policy';
export * from './sandbox-adapter';
export * from './settings-change-detector';
export { PermissionEngine } from './engine';
export { SettingsLoader } from './settings-loader';
export type { SettingsFile, SettingsPermissions } from './settings-loader';
export * from './sandbox-meta-policy';
// Note: llm-classifier.ts has been removed. LLMClassifierProvider and
// classifyPermissionRequest are now exported from ./classifier.
export {
  loadPersistedRules,
  savePersistedRules,
  addPermanentRule,
  removePermanentRule,
  getPermanentRules,
  clearPersistedRules,
} from './rule-persistence';
export type { PersistedRule } from './rule-persistence';
