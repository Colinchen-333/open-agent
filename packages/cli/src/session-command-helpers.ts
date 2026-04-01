import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from '@open-agent/core';

export interface SessionManagerLike {
  listSessions(cwd: string): SessionInfo[];
  getSession(cwd: string, sessionId: string): SessionInfo | null;
  readTranscript(cwd: string, sessionId: string): unknown[];
}

export interface ListSessionsOptions {
  sessionManager: SessionManagerLike;
  cwd: string;
  limit?: number;
}

export interface ListSessionsResult {
  sessions: SessionInfo[];
  output: string;
}

export interface InspectSessionOptions {
  sessionManager: SessionManagerLike;
  cwd: string;
  sessionId: string;
}

export interface InspectSessionResult {
  session: SessionInfo | null;
  transcriptEntryCount: number;
  conversationEntryCount: number;
  output: string;
}

export interface DeleteSessionOptions {
  sessionManager: SessionManagerLike;
  cwd: string;
  sessionId: string;
  homeDir?: string;
}

export interface DeleteSessionResult {
  deleted: boolean;
  removedPaths: string[];
  output: string;
}

export type SessionExportFormat = 'markdown' | 'jsonl';

export interface BuildSessionExportOptions {
  sessionManager: SessionManagerLike;
  cwd: string;
  sessionId: string;
  format: SessionExportFormat;
}

export interface BuildSessionExportResult {
  ok: boolean;
  session: SessionInfo | null;
  transcriptEntryCount: number;
  format: SessionExportFormat;
  fileName: string;
  content: string;
  output: string;
}

export interface WriteSessionExportOptions extends BuildSessionExportOptions {
  outputPath: string;
}

export interface WriteSessionExportResult extends BuildSessionExportResult {
  path: string;
  bytesWritten: number;
}

export function listSessionsForCwd(options: ListSessionsOptions): ListSessionsResult {
  const sessions = options.sessionManager.listSessions(options.cwd);
  const limit = Math.max(1, options.limit ?? 20);
  const visible = sessions.slice(0, limit);

  if (visible.length === 0) {
    return { sessions: [], output: 'No sessions found.' };
  }

  const lines = visible.map((session, index) => {
    const ts = safeDate(session.lastActiveAt);
    const model = session.model || 'unknown';
    return `  ${index + 1}. ${session.id} | ${model} | ${ts}`;
  });

  const note = sessions.length > visible.length
    ? `\nShowing ${visible.length}/${sessions.length}. Increase limit to view more.`
    : '';

  return {
    sessions: visible,
    output: `Sessions (${sessions.length}):\n${lines.join('\n')}${note}`,
  };
}

export function inspectSession(options: InspectSessionOptions): InspectSessionResult {
  const session = options.sessionManager.getSession(options.cwd, options.sessionId);
  if (!session) {
    return {
      session: null,
      transcriptEntryCount: 0,
      conversationEntryCount: 0,
      output: `Session not found: ${options.sessionId}`,
    };
  }

  const transcript = options.sessionManager.readTranscript(session.cwd, session.id);
  const conversationEntryCount = transcript
    .filter((entry) => {
      const record = asRecord(entry);
      const type = asString(record?.type);
      return type === 'user' || type === 'assistant' || type === 'tool_result';
    })
    .length;

  const lines = [
    `Session: ${session.id}`,
    `  Model: ${session.model}`,
    `  CWD: ${session.cwd}`,
    `  Created: ${safeDate(session.createdAt)}`,
    `  Last active: ${safeDate(session.lastActiveAt)}`,
    `  Transcript entries: ${transcript.length}`,
    `  Conversation entries: ${conversationEntryCount}`,
  ];

  if (session.title) {
    lines.push(`  Title: ${session.title}`);
  }
  if (session.summary) {
    lines.push(`  Summary: ${session.summary}`);
  }

  return {
    session,
    transcriptEntryCount: transcript.length,
    conversationEntryCount,
    output: lines.join('\n'),
  };
}

export function deleteSessionArtifacts(options: DeleteSessionOptions): DeleteSessionResult {
  const home = options.homeDir ?? homedir();
  const baseDir = join(home, '.open-agent', 'projects');
  const session = options.sessionManager.getSession(options.cwd, options.sessionId);

  const candidateCwds = dedupeStrings([
    options.cwd,
    session?.cwd,
  ]);

  const removedPaths: string[] = [];
  for (const cwd of candidateCwds) {
    for (const projectDir of getProjectDirsForLookup(baseDir, cwd)) {
      const metaPath = join(projectDir, `${options.sessionId}.meta.json`);
      const transcriptPath = join(projectDir, `${options.sessionId}.jsonl`);
      const artefactDir = join(projectDir, options.sessionId);

      if (existsSync(metaPath)) {
        unlinkSync(metaPath);
        removedPaths.push(metaPath);
      }
      if (existsSync(transcriptPath)) {
        unlinkSync(transcriptPath);
        removedPaths.push(transcriptPath);
      }
      if (existsSync(artefactDir)) {
        rmSync(artefactDir, { recursive: true, force: true });
        removedPaths.push(artefactDir);
      }
    }
  }

  const indexPath = join(baseDir, 'sessions-index.json');
  let indexRemoved = false;
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Record<string, string>;
      if (Object.prototype.hasOwnProperty.call(index, options.sessionId)) {
        delete index[options.sessionId];
        writeFileSync(indexPath, JSON.stringify(index));
        indexRemoved = true;
      }
    } catch {
      // Ignore malformed index file; deletion can still succeed for session artefacts.
    }
  }

  const deleted = removedPaths.length > 0 || indexRemoved;
  if (!deleted) {
    return {
      deleted: false,
      removedPaths: [],
      output: `No artefacts found for session ${options.sessionId}.`,
    };
  }

  const lines = [
    `Deleted session ${options.sessionId}.`,
    ...removedPaths.map((path) => `  - ${path}`),
    ...(indexRemoved ? ['  - removed from global session index'] : []),
  ];

  return {
    deleted: true,
    removedPaths,
    output: lines.join('\n'),
  };
}

export function buildSessionTranscriptExport(
  options: BuildSessionExportOptions,
): BuildSessionExportResult {
  const session = options.sessionManager.getSession(options.cwd, options.sessionId);
  const transcriptCwd = session?.cwd ?? options.cwd;
  const transcript = options.sessionManager.readTranscript(transcriptCwd, options.sessionId);

  if (!session && transcript.length === 0) {
    return {
      ok: false,
      session: null,
      transcriptEntryCount: 0,
      format: options.format,
      fileName: `${options.sessionId}.${extForFormat(options.format)}`,
      content: '',
      output: `Session not found: ${options.sessionId}`,
    };
  }

  const content = options.format === 'jsonl'
    ? toJsonl(transcript)
    : toMarkdown({
      sessionId: options.sessionId,
      session,
      transcript,
      cwd: transcriptCwd,
    });

  return {
    ok: true,
    session,
    transcriptEntryCount: transcript.length,
    format: options.format,
    fileName: `${options.sessionId}.${extForFormat(options.format)}`,
    content,
    output: `Prepared ${options.format.toUpperCase()} export for session ${options.sessionId} (${transcript.length} entries).`,
  };
}

export function writeSessionTranscriptExport(
  options: WriteSessionExportOptions,
): WriteSessionExportResult {
  const built = buildSessionTranscriptExport(options);
  if (!built.ok) {
    return {
      ...built,
      path: resolve(options.outputPath),
      bytesWritten: 0,
    };
  }

  const path = resolve(options.outputPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, built.content, 'utf-8');

  return {
    ...built,
    path,
    bytesWritten: Buffer.byteLength(built.content, 'utf-8'),
    output: `Exported session ${options.sessionId} to ${path}`,
  };
}

function toJsonl(entries: unknown[]): string {
  if (entries.length === 0) return '';
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function toMarkdown(params: {
  sessionId: string;
  session: SessionInfo | null;
  transcript: unknown[];
  cwd: string;
}): string {
  const lines: string[] = [
    `# Session Transcript: ${params.sessionId}`,
    '',
    `- Exported at: ${new Date().toISOString()}`,
    `- CWD: ${params.session?.cwd ?? params.cwd}`,
    `- Model: ${params.session?.model ?? 'unknown'}`,
    `- Entries: ${params.transcript.length}`,
    '',
  ];

  if (params.transcript.length === 0) {
    lines.push('_No transcript entries found._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Entries');
  lines.push('');

  params.transcript.forEach((entry, index) => {
    const record = asRecord(entry) ?? {};
    const type = asString(record.type) ?? 'unknown';
    lines.push(`### ${index + 1}. ${type}`);

    if (type === 'user' || type === 'assistant') {
      const message = asRecord(record.message);
      const content = message?.content;
      lines.push(renderMessageContent(content));
    } else if (type === 'tool_result') {
      const toolUseId = asString(record.tool_use_id);
      if (toolUseId) lines.push(`Tool use id: \`${toolUseId}\``);
      lines.push('');
      lines.push('```text');
      lines.push(stringifyTextLike(record._fullResult ?? record.result));
      lines.push('```');
    } else if (type === 'result') {
      const subtype = asString(record.subtype) ?? 'unknown';
      lines.push(`Subtype: \`${subtype}\``);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(record, null, 2));
      lines.push('```');
    } else {
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(record, null, 2));
      lines.push('```');
    }

    lines.push('');
  });

  return lines.join('\n');
}

function renderMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return `\n\`\`\`text\n${content}\n\`\`\``;
  }

  if (!Array.isArray(content)) {
    return '\n```text\n(no content)\n```';
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block) ?? {};
    const blockType = asString(record.type) ?? 'unknown';

    if (blockType === 'text' || blockType === 'thinking' || blockType === 'redacted_thinking') {
      const text = stringifyTextLike(record.text ?? record.thinking ?? record.data);
      parts.push(`- ${blockType}`);
      parts.push('```text');
      parts.push(text);
      parts.push('```');
      continue;
    }

    if (blockType === 'tool_use') {
      parts.push(`- tool_use: ${asString(record.name) ?? '(unnamed)'}`);
      parts.push('```json');
      parts.push(JSON.stringify(record.input ?? {}, null, 2));
      parts.push('```');
      continue;
    }

    parts.push(`- ${blockType}`);
    parts.push('```json');
    parts.push(JSON.stringify(record, null, 2));
    parts.push('```');
  }

  return `\n${parts.join('\n')}`;
}

function extForFormat(format: SessionExportFormat): string {
  return format === 'markdown' ? 'md' : 'jsonl';
}

function safeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function stringifyTextLike(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      set.add(value);
    }
  }
  return [...set];
}

function getProjectDirsForLookup(baseDir: string, cwd: string): string[] {
  const hashed = join(baseDir, getHashedProjectKey(cwd));
  const legacy = join(baseDir, getLegacyProjectKey(cwd));
  return hashed === legacy ? [hashed] : [hashed, legacy];
}

function getHashedProjectKey(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `v2-${digest.slice(0, 32)}`;
}

function getLegacyProjectKey(cwd: string): string {
  return cwd.replace(/\//g, '-').replace(/^-/, '');
}

function normalizeCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
