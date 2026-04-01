import React from 'react';
import { Box, Text } from 'ink';
import { StoreProvider } from './hooks/useStore.js';
import { REPL } from './components/REPL.js';
import type { Store, AppState } from '@open-agent/state';
import type { ConversationLoop } from '@open-agent/core';

interface AppProps {
  store: Store<AppState>;
  loop: ConversationLoop;
  model: string;
  cwd: string;
}

export function App({ store, loop, model, cwd }: AppProps) {
  return (
    <StoreProvider store={store}>
      <Box flexDirection="column">
        <Box borderStyle="single" borderColor="blue" paddingX={1}>
          <Text bold>Open Agent</Text>
          <Text dimColor> · {model} · {cwd}</Text>
        </Box>
        <REPL loop={loop} />
      </Box>
    </StoreProvider>
  );
}
