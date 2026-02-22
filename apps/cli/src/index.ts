#!/usr/bin/env bun
// open-agent CLI entry point

import { HOOK_EVENTS } from '@open-agent/core';

const VERSION = '0.1.0';

function printUsage(): void {
  console.log(`open-agent v${VERSION}`);
  console.log('');
  console.log('Usage: open-agent [options] [prompt]');
  console.log('');
  console.log('Options:');
  console.log('  --version   Show version');
  console.log('  --help      Show this help message');
  console.log('');
  console.log(`Supported hook events: ${HOOK_EVENTS.join(', ')}`);
}

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  printUsage();
  process.exit(0);
}

// TODO: wire up ConversationLoop, providers, and tools
console.error('open-agent: not yet implemented');
process.exit(1);
