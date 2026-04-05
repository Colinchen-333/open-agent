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
 *
 * When bash exits (e.g. due to `set -e`), the in-flight execCommand synthesises
 * a result using the shell exit code and then exits the worker process.
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

// Shell exit state — shared between the onExit callback and execCommand.
let shellExitCode = null;
let shellExited = false;

// Callback invoked by execCommand when it completes while shellExited is true.
// The exec function sets this so onExit can chain to it.
let onExecDone = null;

shell.onExit(({ exitCode }) => {
  shellExited = true;
  shellExitCode = typeof exitCode === 'number' ? exitCode : null;
  // If there is an active exec, let it handle the exit.
  // Otherwise, exit the worker process directly.
  if (!onExecDone) {
    setTimeout(() => process.exit(0), 50);
  }
  // Safety net — if the exec never finishes, still exit eventually.
  setTimeout(() => process.exit(0), 2000);
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

/**
 * Parse the accumulated PTY buffer to extract actual command output.
 *
 * The `beforeMarker` block looks like:
 *   [echoed user command line(s)]
 *   [actual stdout output]
 *   [echoed sentinel write: __ec=$?; printf ...]
 */
function parseOutput(text, command, marker) {
  const lines = text.split('\n');

  // 1. Remove the sentinel echo — the last line containing '__ec=$?' or the marker
  const sentinelEchoIdx = lines.findLastIndex(
    (l) => l.includes('__ec=$?') || l.includes(marker)
  );
  const trimmedLines = sentinelEchoIdx !== -1
    ? lines.slice(0, sentinelEchoIdx)
    : lines;

  // 2. Drop the echoed user command (first non-empty line that starts with the command)
  const firstToken = command.trimStart().split(/[\s;|&]/)[0] || '';
  let start = 0;
  if (firstToken.length > 0 && trimmedLines.length > 0) {
    const firstNonEmpty = trimmedLines.findIndex((l) => l.trim() !== '');
    if (firstNonEmpty !== -1 && trimmedLines[firstNonEmpty].includes(firstToken)) {
      start = firstNonEmpty + 1;
    }
  }

  return trimmedLines.slice(start).join('\n').replace(/\n+$/, '');
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

  return new Promise((resolve) => {
    // Register as the exec-done callback so onExit knows we're active.
    onExecDone = () => {
      onExecDone = null;
      resolve();
      // Exit the worker now that the result has been sent.
      setTimeout(() => process.exit(0), 50);
    };

    const pollInterval = setInterval(() => {
      // Timeout check
      if (Date.now() > deadline) {
        clearInterval(pollInterval);
        if (!shellExited) shell.write('\x03');
        sendError(id, 'command timeout after ' + timeout + 'ms');
        // Allow a brief drain before proceeding
        setTimeout(() => {
          buffer = '';
          onExecDone = null;
          resolve();
        }, 200);
        return;
      }

      // Shell exited while we were waiting — synthesise a result.
      if (shellExited) {
        clearInterval(pollInterval);
        // Brief grace period for any last data
        setTimeout(() => {
          const clean = buffer.replace(ANSI_RE, '');
          const stdout = parseOutput(clean, command, marker);
          // Send the result first, then signal that the shell is done.
          // The parent will mark the worker dead upon receiving shell-exited.
          sendResult(id, stdout, shellExitCode);
          process.stdout.write(JSON.stringify({ type: 'shell-exited' }) + '\n');
          if (onExecDone) onExecDone = null;
          resolve();
          // Give the parent time to process stdout data before we exit.
          // This is important because Bun processes child stdout asynchronously.
          setTimeout(() => process.exit(0), 100);
        }, 50);
        return;
      }

      const clean = buffer.replace(ANSI_RE, '');

      // The marker appears on its own line in the output (preceded by \n).
      const nlMarker = '\n' + marker;
      const idx = clean.indexOf(nlMarker);
      if (idx === -1) return; // not done yet

      clearInterval(pollInterval);

      const beforeMarker = clean.slice(0, idx);
      const afterMarker = clean.slice(idx + nlMarker.length);

      // Exit code is the first token after the marker on the same line
      const exitStr = afterMarker.split('\n')[0].trim();
      const exitCode = exitStr !== '' && /^\d+$/.test(exitStr) ? parseInt(exitStr, 10) : null;

      const stdout = parseOutput(beforeMarker, command, marker);
      sendResult(id, stdout, exitCode);
      onExecDone = null;
      resolve();
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// IPC: read commands from stdin (one JSON line per message)
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  // Don't accept new commands after the shell has exited.
  if (shellExited) return;

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
