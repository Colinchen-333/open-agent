/**
 * Persist permission rules to disk so they survive session restarts.
 * Rules are saved to ~/.claude/permission-rules.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface PersistedRule {
  behavior: 'allow' | 'deny' | 'ask';
  toolName: string;
  ruleContent?: string;
  createdAt: string;
  /** Scope: 'session' rules are cleared on restart, 'permanent' persist. */
  scope: 'session' | 'permanent';
}

const RULES_FILE = 'permission-rules.json';

function getRulesFilePath(): string {
  return join(homedir(), '.claude', RULES_FILE);
}

/** Load persisted rules from disk. */
export function loadPersistedRules(): PersistedRule[] {
  try {
    const data = readFileSync(getRulesFilePath(), 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save rules to disk. */
export function savePersistedRules(rules: PersistedRule[]): void {
  const path = getRulesFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rules, null, 2), 'utf-8');
}

/** Add a permanent rule (survives restart). */
export function addPermanentRule(
  behavior: 'allow' | 'deny',
  toolName: string,
  ruleContent?: string,
): void {
  const rules = loadPersistedRules();
  // Remove any existing rule for same tool+content
  const filtered = rules.filter(r =>
    !(r.toolName === toolName && r.ruleContent === ruleContent),
  );
  filtered.push({
    behavior,
    toolName,
    ruleContent,
    createdAt: new Date().toISOString(),
    scope: 'permanent',
  });
  savePersistedRules(filtered);
}

/** Remove a persisted rule. */
export function removePermanentRule(toolName: string, ruleContent?: string): boolean {
  const rules = loadPersistedRules();
  const filtered = rules.filter(r =>
    !(r.toolName === toolName && r.ruleContent === ruleContent),
  );
  if (filtered.length < rules.length) {
    savePersistedRules(filtered);
    return true;
  }
  return false;
}

/** Get all permanent rules (for engine hydration at startup). */
export function getPermanentRules(): PersistedRule[] {
  return loadPersistedRules().filter(r => r.scope === 'permanent');
}

/** Clear all persisted rules. */
export function clearPersistedRules(): void {
  savePersistedRules([]);
}
