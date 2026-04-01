import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import type { Store, AppState } from '@open-agent/state';
import type { ConversationLoop } from '@open-agent/core';

export interface RenderOptions {
  store: Store<AppState>;
  loop: ConversationLoop;
  model: string;
  cwd: string;
}

export function renderApp(options: RenderOptions) {
  const { waitUntilExit } = render(
    <App
      store={options.store}
      loop={options.loop}
      model={options.model}
      cwd={options.cwd}
    />,
  );
  return waitUntilExit;
}
