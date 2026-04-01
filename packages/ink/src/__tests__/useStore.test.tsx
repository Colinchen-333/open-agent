import { describe, it, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { createStore } from '@open-agent/state';
import { StoreProvider, useStore } from '../hooks/useStore.js';

function Counter() {
  const count = useStore<{ count: number }, number>(s => s.count);
  return React.createElement(Text, null, `Count: ${count}`);
}

describe('useStore', () => {
  it('reads initial state', () => {
    const store = createStore({ count: 0 });
    const { lastFrame } = render(
      React.createElement(StoreProvider, { store }, React.createElement(Counter)),
    );
    expect(lastFrame()).toContain('Count: 0');
  });

  it('re-renders on state change', async () => {
    const store = createStore({ count: 0 });
    const { lastFrame } = render(
      React.createElement(StoreProvider, { store }, React.createElement(Counter)),
    );

    store.setState(prev => ({ ...prev, count: 42 }));
    // flush React's microtask scheduler
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(lastFrame()).toContain('Count: 42');
  });
});
