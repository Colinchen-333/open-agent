import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { TeamConfig, TeamInboxEntry, TeamMember, TeamMessage } from './types';

export class TeamManager {
  private baseDir: string;
  private messageSequence = 0;

  constructor() {
    this.baseDir = join(homedir(), '.open-agent', 'teams');
  }

  // ---------------------------------------------------------------------------
  // Team CRUD
  // ---------------------------------------------------------------------------

  /** Create a new team. Idempotent — safe to call if team already exists. */
  createTeam(name: string, description?: string): TeamConfig {
    const teamDir = join(this.baseDir, name);
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });
    mkdirSync(this.getScratchpadDir(name), { recursive: true });

    // Preserve existing config if the team already exists.
    const existing = this.getTeam(name);
    if (existing) {
      if (description !== undefined) {
        existing.description = description;
        this.saveTeam(existing);
      }
      mkdirSync(this.getScratchpadDir(name), { recursive: true });
      return existing;
    }

    const config: TeamConfig = {
      name,
      description,
      members: [],
      createdAt: new Date().toISOString(),
    };

    writeFileSync(join(teamDir, 'config.json'), JSON.stringify(config, null, 2));

    // Create task directory for this team.
    const taskDir = join(homedir(), '.open-agent', 'tasks', name);
    mkdirSync(taskDir, { recursive: true });

    return config;
  }

  /** Delete a team and its associated task directory. */
  deleteTeam(name: string): void {
    const teamDir = join(this.baseDir, name);
    if (existsSync(teamDir)) {
      rmSync(teamDir, { recursive: true, force: true });
    }
    const taskDir = join(homedir(), '.open-agent', 'tasks', name);
    if (existsSync(taskDir)) {
      rmSync(taskDir, { recursive: true, force: true });
    }
  }

  /** Return team configuration, or null if the team does not exist. */
  getTeam(name: string): TeamConfig | null {
    const configPath = join(this.baseDir, name, 'config.json');
    if (!existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Persist team configuration to disk. */
  private saveTeam(config: TeamConfig): void {
    writeFileSync(
      join(this.baseDir, config.name, 'config.json'),
      JSON.stringify(config, null, 2),
    );
  }

  /** List all team names that have a config.json. */
  listTeams(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir).filter(f =>
      existsSync(join(this.baseDir, f, 'config.json')),
    );
  }

  getTeamDir(name: string): string {
    return join(this.baseDir, name);
  }

  getScratchpadDir(name: string): string {
    return join(this.getTeamDir(name), 'scratchpad');
  }

  // ---------------------------------------------------------------------------
  // Member management
  // ---------------------------------------------------------------------------

  /**
   * Add a member to a team.  Creates the team if it does not yet exist.
   * Also provisions an inbox directory for the member.
   */
  addMember(teamName: string, member: TeamMember): void {
    let config = this.getTeam(teamName);
    if (!config) {
      config = this.createTeam(teamName);
    }

    // Replace any existing member with the same name.
    config.members = config.members.filter(m => m.name !== member.name);
    config.members.push(member);
    this.saveTeam(config);

    // Ensure inbox directory exists.
    this.ensureInboxDir(teamName, member.name);
  }

  /** Remove a member by name. No-op if the member does not exist. */
  removeMember(teamName: string, memberName: string): void {
    const config = this.getTeam(teamName);
    if (!config) return;
    config.members = config.members.filter(m => m.name !== memberName);
    this.saveTeam(config);
  }

  /** Return all members of a team, or an empty array if the team does not exist. */
  getMembers(teamName: string): TeamMember[] {
    return this.getTeam(teamName)?.members ?? [];
  }

  /** Update a member's status field in the team config. */
  updateMemberStatus(teamName: string, memberName: string, status: TeamMember['status']): void {
    const config = this.getTeam(teamName);
    if (!config) return;
    const member = config.members.find(m => m.name === memberName);
    if (!member) return;
    member.status = status;
    this.saveTeam(config);
  }

  // ---------------------------------------------------------------------------
  // Inbox / messaging
  // ---------------------------------------------------------------------------

  private ensureInboxDir(teamName: string, memberName: string): string {
    const dir = join(this.baseDir, teamName, 'inboxes', memberName);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private getInboxStatePath(teamName: string, memberName: string): string {
    return join(this.ensureInboxDir(teamName, memberName), '.read-state.json');
  }

  private loadInboxState(teamName: string, memberName: string): Record<string, string> {
    const statePath = this.getInboxStatePath(teamName, memberName);
    if (!existsSync(statePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as { acknowledged?: Record<string, string> };
      return parsed.acknowledged && typeof parsed.acknowledged === 'object'
        ? parsed.acknowledged
        : {};
    } catch {
      return {};
    }
  }

  private saveInboxState(teamName: string, memberName: string, acknowledged: Record<string, string>): void {
    const statePath = this.getInboxStatePath(teamName, memberName);
    writeFileSync(statePath, JSON.stringify({ acknowledged }, null, 2));
  }

  private listInboxFiles(teamName: string, memberName: string): string[] {
    const inboxDir = join(this.baseDir, teamName, 'inboxes', memberName);
    if (!existsSync(inboxDir)) return [];
    return readdirSync(inboxDir)
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .sort();
  }

  /**
   * Write a message to one or more inboxes.
   *
   * - `message`              → writes to `message.to`'s inbox
   * - `broadcast`            → writes to every member's inbox
   * - `shutdown_request`     → writes to recipient's inbox with a stable requestId
   * - `shutdown_response`    → writes to sender's inbox (team lead)
   * - `plan_approval_*`      → writes to recipient's inbox
   * - `idle_notification`    → writes to team lead inbox (first member, or 'lead')
   */
  sendMessage(teamName: string, message: TeamMessage): void {
    mkdirSync(join(this.baseDir, teamName, 'inboxes'), { recursive: true });

    const sequence = String(this.messageSequence++).padStart(6, '0');
    const filename = `${Date.now()}-${sequence}-${randomUUID().slice(0, 8)}.json`;

    // Ensure requestId is set for request/response types.
    if (!message.requestId && (message.type === 'shutdown_request' || message.type === 'plan_approval_request')) {
      message = { ...message, requestId: randomUUID() };
    }

    if (message.type === 'broadcast') {
      // Write to every known member's inbox.
      const members = this.getMembers(teamName);
      const targets = members.length > 0
        ? members.map(m => m.name)
        : ['broadcast'];

      for (const memberName of targets) {
        const dir = this.ensureInboxDir(teamName, memberName);
        writeFileSync(join(dir, filename), JSON.stringify(message, null, 2));
      }
      return;
    }

    if (message.type === 'idle_notification') {
      // Send to the team lead (first member named 'lead', or first member overall,
      // or fall back to a 'lead' inbox).
      const members = this.getMembers(teamName);
      const lead = members.find(m => m.name === 'lead') ?? members[0];
      const target = lead?.name ?? 'lead';
      const dir = this.ensureInboxDir(teamName, target);
      writeFileSync(join(dir, filename), JSON.stringify(message, null, 2));
      return;
    }

    // All other types: write to the named recipient's inbox.
    const target = message.to ?? 'unknown';
    const dir = this.ensureInboxDir(teamName, target);
    writeFileSync(join(dir, filename), JSON.stringify(message, null, 2));
  }

  /**
   * Read and REMOVE all messages from a member's inbox (queue / consume semantics).
   * Messages are returned in chronological order (oldest first).
   */
  readInbox(teamName: string, memberName: string): TeamMessage[] {
    return this.readInboxEntries(teamName, memberName, { consume: true }).map((entry) => entry.message);
  }

  /**
   * Peek at messages without consuming them (non-destructive read).
   * Sorted chronologically (oldest first).
   */
  readMessages(teamName: string, memberName: string): TeamMessage[] {
    return this.readInboxEntries(teamName, memberName).map((entry) => entry.message);
  }

  readInboxEntries(
    teamName: string,
    memberName: string,
    options: {
      after?: string;
      acknowledge?: boolean;
      consume?: boolean;
      limit?: number;
      unreadOnly?: boolean;
    } = {},
  ): TeamInboxEntry[] {
    const inboxDir = join(this.baseDir, teamName, 'inboxes', memberName);
    if (!existsSync(inboxDir)) return [];

    const acknowledged = this.loadInboxState(teamName, memberName);
    const files = this.listInboxFiles(teamName, memberName);
    const afterIndex = options.after ? files.indexOf(options.after) : -1;
    const selectedFiles = files
      .filter((_, index) => afterIndex < 0 || index > afterIndex)
      .filter((file) => !options.unreadOnly || !acknowledged[file])
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    const entries: TeamInboxEntry[] = [];
    let stateChanged = false;

    for (const file of selectedFiles) {
      const filePath = join(inboxDir, file);
      let claimedPath = filePath;
      try {
        if (options.consume) {
          claimedPath = join(
            inboxDir,
            `.claim-${process.pid}-${randomUUID().slice(0, 8)}-${file}`,
          );
          try {
            renameSync(filePath, claimedPath);
          } catch {
            // Another reader claimed or removed the file first.
            continue;
          }
        }
        const message = JSON.parse(readFileSync(claimedPath, 'utf-8')) as TeamMessage;
        const readAt = acknowledged[file];
        entries.push({
          id: file,
          message,
          ...(readAt ? { readAt } : {}),
        });
        if (options.consume) {
          try {
            unlinkSync(claimedPath);
          } catch {
            // Ignore per-file deletion errors.
          }
          if (acknowledged[file]) {
            delete acknowledged[file];
            stateChanged = true;
          }
          continue;
        }
        if (options.acknowledge && !acknowledged[file]) {
          acknowledged[file] = new Date().toISOString();
          stateChanged = true;
        }
      } catch {
        if (options.consume) {
          try { unlinkSync(claimedPath); } catch { /* ignore */ }
        }
      }
    }

    if (stateChanged) {
      this.saveInboxState(teamName, memberName, acknowledged);
    }

    return entries;
  }

  acknowledgeInboxMessages(teamName: string, memberName: string, ids: string[]): number {
    if (ids.length === 0) return 0;
    const inboxDir = join(this.baseDir, teamName, 'inboxes', memberName);
    if (!existsSync(inboxDir)) return 0;
    const acknowledged = this.loadInboxState(teamName, memberName);
    let updated = 0;
    for (const id of ids) {
      const filePath = join(inboxDir, id);
      if (!existsSync(filePath) || acknowledged[id]) continue;
      acknowledged[id] = new Date().toISOString();
      updated += 1;
    }
    if (updated > 0) {
      this.saveInboxState(teamName, memberName, acknowledged);
    }
    return updated;
  }

  /** Return the number of unread messages in a member's inbox. */
  getInboxCount(teamName: string, memberName: string): number {
    const inboxDir = join(this.baseDir, teamName, 'inboxes', memberName);
    if (!existsSync(inboxDir)) return 0;
    try {
      const acknowledged = this.loadInboxState(teamName, memberName);
      return this.listInboxFiles(teamName, memberName)
        .filter((file) => !acknowledged[file])
        .length;
    } catch {
      return 0;
    }
  }

  /**
   * Notify the team lead that a teammate has gone idle.
   * Automatically called by the agent runtime after a subagent finishes.
   */
  notifyIdle(teamName: string, memberName: string, idleReason = 'available'): void {
    const notification: TeamMessage = {
      type: 'idle_notification',
      from: memberName,
      content: `Agent "${memberName}" is now idle and available for new tasks.`,
      summary: `${memberName} is idle`,
      timestamp: new Date().toISOString(),
      idleReason,
    };
    this.sendMessage(teamName, notification);
  }
}
