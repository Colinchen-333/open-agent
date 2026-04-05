#!/usr/bin/env node
/**
 * bash-pty-worker.js
 *
 * A Node.js CJS helper that owns a persistent bash PTY and exposes it over
 * stdin/stdout using newline-delimited JSON messages.
 *
 * Protocol (parent → worker, each line is a JSON object):
 *   { "cmd": "exec", "id": <number>, "command": <string>, "timeout": <number> }
 *   { "cmd": "kill" }
 *
 * Protocol (worker → parent, each line is a JSON object):
 *   { "type": "ready" }
 *   { "type": "result", "id": <number>, "stdout": <string>, "exitCode": <number|null> }
 *   { "type": "error",  "id": <number>, "message": <string> }
 */

'use strict';

const pty = require('node-pty');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Spawn the persistent bash shell
// ---------------------------------------------------------------------------

const PTY_CWD = process.env.PTY_CWD || process.cwd();
const PTY_ENV = JSON.parse(process.env.PTY_ENV || '{}');

const shell = pty.spawn('bash', ['--noprofile', '--norc'], {
  name: 'xterm-256color',
  cwd: PTY_CWD,
  env: {
    ...process.env,
    ...PTY_ENV,
    PS1: '',
    PS2: '',
    PS3: '',
    PS4: '',
    TERM: 'dumb',
  },
  cols: 200,
  rows: 50,
});

let buffer = '';

// Comprehensive ANSI/VT100 stripping including bracketed paste mode sequences
// (\x1b[?2004h = enable, \x1b[?2004l = disable)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;

shell.onData((chunk) => {
  buffer += chunk;
});

shell.onExit(() => {
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Startup: disable bracketed paste mode so VT sequences don't interrupt output
// ---------------------------------------------------------------------------
const startupReady = new Promise((resolve) => {
  // Give bash 150ms to start, then disable bracketed paste
  setTimeout(() => {
    // Flush any startup output
    buffer = '';
    shell.write('bind "set enable-bracketed-paste off" 2>/dev/null; true\n');
    // Wait for the startup command to complete before signalling ready
    setTimeout(() => {
      buffer = '';
      resolve(undefined);
    }, 150);
  }, 150);
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

const MARKER_PREFIX = '__OA_PTY_DONE_';
let seq = 0;

function sendResult(id, stdout, exitCode) {
  process.stdout.write(JSON.stringify({ type: 'result', id, stdout, exitCode }) + '\n');
}

function sendError(id, message) {
  process.stdout.write(JSON.stringify({ type: 'error', id, message }) + '\n');
}

async function execCommand(id, command, timeout) {
  // Ensure startup has completed
  await startupReady;

  const marker = MARKER_PREFIX + (++seq) + '_';

  // Reset accumulation buffer
  buffer = '';

  // Write command + sentinel.  The `__ec` captures the exit code before
  // printf clobbers it.
  shell.write(command + '\n__ec=$?; printf \'%s%s\\n\' \'' + marker + '\' "$__ec"\n');

  const deadline = Date.now() + timeout;

  while (true) {
    if (Date.now() > deadline) {
      // Interrupt the running command
      shell.write('\x03');
      sendError(id, 'command timeout after ' + timeout + 'ms');
      // Drain buffer briefly so the next command starts clean
      await new Promise((r) => setTimeout(r, 200));
      buffer = '';
      return;
    }

    const clean = buffer.replace(ANSI_RE, '');

    // The marker appears on its own line in the output (preceded by \n).
    // This distinguishes the actual output from the PTY echo of the input.
    const nlMarker = '\n' + marker;
    const idx = clean.indexOf(nlMarker);
    if (idx !== -1) {
      const beforeMarker = clean.slice(0, idx);
      const afterMarker = clean.slice(idx + nlMarker.length);

      // Exit code is the first token after the marker on the same line
      const exitStr = afterMarker.split('\n')[0].trim();
      const exitCode = exitStr !== '' && /^\d+$/.test(exitStr) ? parseInt(exitStr, 10) : null;

      // Parse the actual output.
      //
      // The `beforeMarker` block looks like:
      //   [echoed user command line(s)]
      //   [actual stdout output]
      //   [echoed sentinel write: __ec=$?; printf ...]
      //
      // So we:
      //   1. Drop the sentinel echo line from the end (it contains __ec=$?)
      //   2. Drop the echoed user command from the beginning
      const lines = beforeMarker.split('\n');

      // 1. Remove the sentinel echo — the last line containing '__ec=$?'
      const sentinelEchoIdx = lines.findLastIndex(
        (l) => l.includes('__ec=$?') || l.includes(marker)
      );
      const trimmedLines = sentinelEchoIdx !== -1
        ? lines.slice(0, sentinelEchoIdx)
        : lines;

      // 2. Drop the echoed user command (first non-empty line matching command start)
      const firstToken = command.trimStart().split(/[\s;|&]/)[0] || '';
      let start = 0;
      if (firstToken.length > 0 && trimmedLines.length > 0) {
        const firstNonEmpty = trimmedLines.findIndex((l) => l.trim() !== '');
        if (firstNonEmpty !== -1 && trimmedLines[firstNonEmpty].includes(firstToken)) {
          start = firstNonEmpty + 1;
        }
      }

      const stdout = trimmedLines.slice(start).join('\n').replace(/\n+$/, '');
      sendResult(id, stdout, exitCode);
      return;
    }

    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// IPC: read commands from stdin (one JSON line per message)
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.cmd === 'exec') {
    execCommand(msg.id, msg.command, msg.timeout || 60000).catch((err) => {
      sendError(msg.id, String(err));
    });
  } else if (msg.cmd === 'kill') {
    shell.kill();
    process.exit(0);
  }
});

rl.on('close', () => {
  shell.kill();
  process.exit(0);
});

// Signal ready after startup sequence completes
startupReady.then(() => {
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
});
