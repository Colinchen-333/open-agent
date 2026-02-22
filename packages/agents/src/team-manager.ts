import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { TeamConfig, TeamMember, TeamMessage } from './types';

export class TeamManager {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.open-agent', 'teams');
  }

  // Create a new team
  createTeam(name: string, description?: string): TeamConfig {
    const teamDir = join(this.baseDir, name);
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'inboxes'), { recursive: true });

    const config: TeamConfig = {
      name,
      description,
      members: [],
      createdAt: new Date().toISOString(),
    };

    writeFileSync(join(teamDir, 'config.json'), JSON.stringify(config, null, 2));

    // Create task directory for this team
    const taskDir = join(homedir(), '.open-agent', 'tasks', name);
    mkdirSync(taskDir, { recursive: true });

    return config;
  }

  // Delete a team and its task directory
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

  // Get team configuration
  getTeam(name: string): TeamConfig | null {
    const configPath = join(this.baseDir, name, 'config.json');
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  // Save team configuration
  private saveTeam(config: TeamConfig): void {
    writeFileSync(
      join(this.baseDir, config.name, 'config.json'),
      JSON.stringify(config, null, 2),
    );
  }

  // Add a member to a team
  addMember(teamName: string, member: TeamMember): void {
    const config = this.getTeam(teamName);
    if (!config) throw new Error(`Team ${teamName} not found`);
    config.members.push(member);
    this.saveTeam(config);
  }

  // Send a message to a team member's inbox (or broadcast inbox)
  sendMessage(teamName: string, message: TeamMessage): void {
    const inboxDir = join(this.baseDir, teamName, 'inboxes');
    mkdirSync(inboxDir, { recursive: true });

    const target = message.to || 'broadcast';
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    const targetDir = join(inboxDir, target);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, filename), JSON.stringify(message, null, 2));
  }

  // Read all messages from an agent's inbox (sorted by filename = chronological order)
  readMessages(teamName: string, agentName: string): TeamMessage[] {
    const inboxDir = join(this.baseDir, teamName, 'inboxes', agentName);
    if (!existsSync(inboxDir)) return [];

    const files = readdirSync(inboxDir).filter(f => f.endsWith('.json')).sort();
    const messages: TeamMessage[] = [];

    for (const file of files) {
      try {
        const msg = JSON.parse(readFileSync(join(inboxDir, file), 'utf-8'));
        messages.push(msg);
      } catch {
        // Skip malformed message files
      }
    }

    return messages;
  }

  // List all team names
  listTeams(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir).filter(f =>
      existsSync(join(this.baseDir, f, 'config.json')),
    );
  }
}
