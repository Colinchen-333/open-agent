import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query } from '../types.js';
import { query } from '../query.js';

function makeTempHome(prefix: string): { cwd: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  return {
    cwd,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeBackgroundProvider(): LLMProvider {
  return {
    name: 'mock-sdk-timeline-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('timeline worker aborted for test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Timeline test model' }];
    },
  };
}

async function waitForWorkerStatus(
  q: Query,
  workerId: string,
  expectedStatus: string,
): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const worker = await q.getWorker(workerId);
    if (worker?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('query() timeline control plane', () => {
  it('normalizes team inbox messages into timeline items', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-read-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline inbox', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
      });

      await q.createTeam({ name: teamName, setActive: true });
      await q.sendTeamMessage({
        type: 'message',
        recipient: 'alice',
        content: 'Continue with the delegated task.',
      });

      const items = await q.readTimelineInbox({
        memberName: 'alice',
        consume: false,
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe('team_message');
      expect(items[0]?.teamName).toBe(teamName);
      expect(items[0]?.teamMessage?.content).toBe('Continue with the delegated task.');
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('merges team inbox messages and worker orchestration events into one live stream', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-subscribe-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline stream', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const iterator = q.subscribeTimeline({
        teamName,
        memberName: 'alice',
        pollIntervalMs: 20,
      })[Symbol.asyncIterator]();

      await q.sendTeamMessage({
        type: 'message',
        recipient: 'alice',
        content: 'Watch the worker timeline.',
      });
      const worker = await q.launchWorker({
        prompt: 'Wait until stopped.',
        name: 'alice-worker',
      });

      const seen: any[] = [];
      const timeoutAt = Date.now() + 2_000;
      while (Date.now() < timeoutAt) {
        const next = await iterator.next();
        if (next.done) break;
        seen.push(next.value);
        if (
          seen.some((item) => item.kind === 'team_message' && item.teamMessage?.content === 'Watch the worker timeline.')
          && seen.some((item) => item.kind === 'worker_lifecycle' && item.workerId === worker.workerId)
        ) {
          break;
        }
      }

      expect(seen.some((item) => item.kind === 'team_message' && item.teamMessage?.content === 'Watch the worker timeline.')).toBe(true);
      expect(seen.some((item) => (
        item.kind === 'worker_lifecycle'
        && item.workerId === worker.workerId
        && item.orchestrationEvent?.raw.type === 'launched'
      ))).toBe(true);

      expect(await q.stopWorker(worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, worker.workerId, 'shutdown');
      await iterator.return?.();
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
