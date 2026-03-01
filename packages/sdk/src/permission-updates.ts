import { PermissionEngine } from '@open-agent/permissions';

type PermissionBehavior = 'allow' | 'deny' | 'ask';

const KNOWN_BEHAVIORS = new Set<PermissionBehavior>(['allow', 'deny', 'ask']);

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return typeof value === 'string' && KNOWN_BEHAVIORS.has(value as PermissionBehavior);
}

function isSessionDestination(value: unknown): boolean {
  return value === 'session';
}

export function applyPermissionUpdates(
  permissionEngine: PermissionEngine,
  updates: unknown,
): void {
  if (!Array.isArray(updates)) return;

  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const u = update as Record<string, unknown>;
    if (!isSessionDestination(u.destination)) continue;

    const type = u.type;
    if (type === 'setMode') {
      if (
        u.mode === 'default' ||
        u.mode === 'acceptEdits' ||
        u.mode === 'bypassPermissions' ||
        u.mode === 'plan' ||
        u.mode === 'dontAsk'
      ) {
        permissionEngine.setMode(u.mode);
      }
      continue;
    }

    if (type === 'addDirectories' || type === 'removeDirectories') {
      const dirs = Array.isArray(u.directories)
        ? u.directories.filter((d): d is string => typeof d === 'string' && d.length > 0)
        : [];
      if (dirs.length === 0) continue;
      const summary = permissionEngine.getSummary();
      const next = new Set(summary.allowedPaths);
      if (type === 'addDirectories') {
        for (const dir of dirs) next.add(dir);
      } else {
        for (const dir of dirs) next.delete(dir);
      }
      permissionEngine.setAllowedPaths([...next]);
      continue;
    }

    if (type !== 'addRules' && type !== 'replaceRules' && type !== 'removeRules') {
      continue;
    }
    if (!isPermissionBehavior(u.behavior)) continue;
    const behavior = u.behavior;
    const rules = Array.isArray(u.rules) ? u.rules : [];
    for (const rawRule of rules) {
      if (!rawRule || typeof rawRule !== 'object') continue;
      const ruleObj = rawRule as Record<string, unknown>;
      if (typeof ruleObj.toolName !== 'string') continue;
      const rule = {
        toolName: ruleObj.toolName,
        ...(typeof ruleObj.ruleContent === 'string'
          ? { ruleContent: ruleObj.ruleContent }
          : {}),
      };

      if (type === 'addRules') {
        permissionEngine.addRule(behavior, rule);
        continue;
      }

      if (type === 'replaceRules') {
        for (const b of ['allow', 'deny', 'ask'] as const) {
          permissionEngine.removeRule(b, rule);
        }
        permissionEngine.addRule(behavior, rule);
        continue;
      }

      permissionEngine.removeRule(behavior, rule);
    }
  }
}
