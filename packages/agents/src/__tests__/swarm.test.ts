import { describe, expect, test, beforeEach } from 'bun:test';
import { SwarmDispatcher } from '../swarm';
import { resetMailboxes, getAllMessages } from '../agent-taxonomy';

describe('SwarmDispatcher', () => {
  beforeEach(() => resetMailboxes());

  test('addTask creates queued task', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    const task = swarm.addTask({ name: 'agent1', agentType: 'code-writer', task: 'write code' });
    expect(task.status).toBe('queued');
    expect(task.spec.task).toBe('write code');
  });

  test('registerTeammate adds to pool', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    swarm.registerTeammate('alice', 'agent-1');
    expect(swarm.getState().teammates).toHaveLength(1);
  });

  test('tryAssign matches tasks to teammates', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    swarm.addTask({ name: 'a', agentType: 'writer', task: 'task1' });
    swarm.registerTeammate('alice', 'agent-1');
    const assigned = swarm.tryAssign();
    expect(assigned).toHaveLength(1);
    expect(assigned[0].assignedTo).toBe('alice');
  });

  test('respects maxConcurrent', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 1, autoAssign: false });
    swarm.addTask({ name: 'a', agentType: 'w', task: 't1' });
    swarm.addTask({ name: 'b', agentType: 'w', task: 't2' });
    swarm.registerTeammate('alice', 'a1');
    swarm.registerTeammate('bob', 'a2');
    const assigned = swarm.tryAssign();
    expect(assigned).toHaveLength(1); // only 1 concurrent
  });

  test('completeTask updates state', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    const task = swarm.addTask({ name: 'a', agentType: 'w', task: 't' });
    swarm.registerTeammate('alice', 'a1');
    swarm.tryAssign();
    swarm.completeTask(task.id, 'done');
    expect(swarm.getTasks()[0].status).toBe('completed');
  });

  test('failTask updates state', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    const task = swarm.addTask({ name: 'a', agentType: 'w', task: 't' });
    swarm.registerTeammate('alice', 'a1');
    swarm.tryAssign();
    swarm.failTask(task.id, 'crashed');
    expect(swarm.getTasks()[0].status).toBe('failed');
    expect(swarm.getTasks()[0].error).toBe('crashed');
  });

  test('autoAssign dispatches on addTask', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: true });
    swarm.registerTeammate('alice', 'a1');
    const task = swarm.addTask({ name: 'a', agentType: 'w', task: 'auto' });
    expect(task.status).toBe('assigned');
  });

  test('sends mailbox message on assignment', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    swarm.addTask({ name: 'a', agentType: 'w', task: 'msg-test' });
    swarm.registerTeammate('alice', 'a1');
    swarm.tryAssign();
    const msgs = getAllMessages('alice');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe('coordinator');
  });

  test('getProgress reports correct counts', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 5, autoAssign: false });
    swarm.addTask({ name: 'a', agentType: 'w', task: 't1' });
    swarm.addTask({ name: 'b', agentType: 'w', task: 't2' });
    swarm.registerTeammate('alice', 'a1');
    swarm.tryAssign();
    const progress = swarm.getProgress();
    expect(progress.total).toBe(2);
    expect(progress.queued).toBe(1);
    expect(progress.running).toBe(1);
  });

  test('cancelTask only works for queued', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 2, autoAssign: false });
    const task = swarm.addTask({ name: 'a', agentType: 'w', task: 't' });
    expect(swarm.cancelTask(task.id)).toBe(true);
    expect(swarm.getTasks()[0].status).toBe('cancelled');
  });

  test('priority sorting', () => {
    const swarm = new SwarmDispatcher({ teamName: 'test', maxConcurrent: 1, autoAssign: false });
    swarm.addTask({ name: 'low', agentType: 'w', task: 'low' }, 10);
    swarm.addTask({ name: 'high', agentType: 'w', task: 'high' }, 1);
    swarm.registerTeammate('alice', 'a1');
    const assigned = swarm.tryAssign();
    expect(assigned[0].spec.task).toBe('high');
  });
});
