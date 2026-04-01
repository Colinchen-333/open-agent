import { describe, it, expect, mock } from 'bun:test';
import { createStore } from '../index.js';

describe('createStore', () => {
  it('returns initial state via getState()', () => {
    const store = createStore({ count: 0 });
    expect(store.getState()).toEqual({ count: 0 });
  });

  it('updates state via setState()', () => {
    const store = createStore({ count: 0 });
    store.setState(prev => ({ ...prev, count: prev.count + 1 }));
    expect(store.getState()).toEqual({ count: 1 });
  });

  it('skips update when state identity unchanged (Object.is)', () => {
    const listener = mock(() => {});
    const initial = { count: 0 };
    const store = createStore(initial);
    store.subscribe(listener);

    store.setState(prev => prev); // identity — no change
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on state change', () => {
    const listener = mock(() => {});
    const store = createStore({ count: 0 });
    store.subscribe(listener);

    store.setState(prev => ({ ...prev, count: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const listener = mock(() => {});
    const store = createStore({ count: 0 });
    const unsub = store.subscribe(listener);

    unsub();
    store.setState(prev => ({ ...prev, count: 1 }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('calls onChange callback with prev and next', () => {
    const onChange = mock(() => {});
    const store = createStore({ count: 0 }, onChange);

    store.setState(prev => ({ ...prev, count: 5 }));
    expect(onChange).toHaveBeenCalledWith({ count: 0 }, { count: 5 });
  });

  it('supports multiple subscribers', () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const store = createStore({ x: 1 });
    store.subscribe(a);
    store.subscribe(b);

    store.setState(prev => ({ ...prev, x: 2 }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
