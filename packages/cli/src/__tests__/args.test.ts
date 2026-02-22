import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../args.js';

describe('parseArgs', () => {
  // ---------------------------------------------------------------------------
  // --model
  // ---------------------------------------------------------------------------

  describe('--model', () => {
    it('parses --model value', () => {
      expect(parseArgs(['--model', 'claude-3-5-sonnet']).model).toBe('claude-3-5-sonnet');
    });

    it('parses --model=value (equals form)', () => {
      expect(parseArgs(['--model=claude-opus-4']).model).toBe('claude-opus-4');
    });

    it('parses -m short alias', () => {
      expect(parseArgs(['-m', 'gpt-4o']).model).toBe('gpt-4o');
    });
  });

  // ---------------------------------------------------------------------------
  // --prompt / positional
  // ---------------------------------------------------------------------------

  describe('--prompt', () => {
    it('parses --prompt value', () => {
      expect(parseArgs(['--prompt', 'hello world']).prompt).toBe('hello world');
    });

    it('parses --prompt=value (equals form)', () => {
      expect(parseArgs(['--prompt=hello']).prompt).toBe('hello');
    });

    it('parses -p short alias', () => {
      expect(parseArgs(['-p', 'say hi']).prompt).toBe('say hi');
    });

    it('treats positional arguments as prompt text', () => {
      expect(parseArgs(['what', 'is', '2+2']).prompt).toBe('what is 2+2');
    });

    it('--prompt takes precedence over positional arguments', () => {
      // When --prompt is set, positional args should not override it.
      // The parser sets prompt from --prompt first, then positionals only fill if undefined.
      const result = parseArgs(['--prompt', 'explicit', 'positional']);
      // 'positional' is appended to positional array but prompt is already set by --prompt.
      expect(result.prompt).toBe('explicit');
    });
  });

  // ---------------------------------------------------------------------------
  // --resume / --continue
  // ---------------------------------------------------------------------------

  describe('--resume', () => {
    it('parses --resume session-id', () => {
      expect(parseArgs(['--resume', 'abc-123']).resume).toBe('abc-123');
    });

    it('parses -r session-id', () => {
      expect(parseArgs(['-r', 'def-456']).resume).toBe('def-456');
    });
  });

  describe('--continue', () => {
    it('sets continue to true when flag is present', () => {
      expect(parseArgs(['--continue']).continue).toBe(true);
    });

    it('sets continue to true via -c short alias', () => {
      expect(parseArgs(['-c']).continue).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // --provider
  // ---------------------------------------------------------------------------

  describe('--provider', () => {
    it('parses --provider value', () => {
      expect(parseArgs(['--provider', 'openai']).provider).toBe('openai');
    });

    it('parses --provider=value (equals form)', () => {
      expect(parseArgs(['--provider=anthropic']).provider).toBe('anthropic');
    });
  });

  // ---------------------------------------------------------------------------
  // --help / --version
  // ---------------------------------------------------------------------------

  describe('--help', () => {
    it('sets help to true', () => {
      expect(parseArgs(['--help']).help).toBe(true);
    });

    it('-h short alias sets help', () => {
      expect(parseArgs(['-h']).help).toBe(true);
    });
  });

  describe('--version', () => {
    it('sets version to true', () => {
      expect(parseArgs(['--version']).version).toBe(true);
    });

    it('-v short alias sets version', () => {
      expect(parseArgs(['-v']).version).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // --max-turns
  // ---------------------------------------------------------------------------

  describe('--max-turns', () => {
    it('parses --max-turns as a number', () => {
      expect(parseArgs(['--max-turns', '5']).maxTurns).toBe(5);
    });

    it('parses --max-turns=10 (equals form)', () => {
      expect(parseArgs(['--max-turns=10']).maxTurns).toBe(10);
    });

    it('ignores non-numeric max-turns values', () => {
      // parseInt('abc') is NaN, so maxTurns should remain undefined.
      expect(parseArgs(['--max-turns', 'abc']).maxTurns).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // --output-format
  // ---------------------------------------------------------------------------

  describe('--output-format', () => {
    it('accepts "text"', () => {
      expect(parseArgs(['--output-format', 'text']).outputFormat).toBe('text');
    });

    it('accepts "stream-json"', () => {
      expect(parseArgs(['--output-format', 'stream-json']).outputFormat).toBe('stream-json');
    });

    it('ignores unknown output format values', () => {
      // Should not set outputFormat for unknown values.
      expect(parseArgs(['--output-format', 'xml']).outputFormat).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // --verbose / --debug
  // ---------------------------------------------------------------------------

  describe('--verbose / --debug', () => {
    it('sets verbose to true via --verbose', () => {
      expect(parseArgs(['--verbose']).verbose).toBe(true);
    });

    it('sets verbose to true via --debug alias', () => {
      expect(parseArgs(['--debug']).verbose).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // --api-key / --base-url
  // ---------------------------------------------------------------------------

  describe('--api-key', () => {
    it('parses --api-key value', () => {
      expect(parseArgs(['--api-key', 'sk-my-key']).apiKey).toBe('sk-my-key');
    });
  });

  describe('--base-url', () => {
    it('parses --base-url value', () => {
      expect(parseArgs(['--base-url', 'https://api.example.com']).baseURL).toBe(
        'https://api.example.com',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // --permission-mode
  // ---------------------------------------------------------------------------

  describe('--permission-mode', () => {
    it('parses --permission-mode value', () => {
      expect(parseArgs(['--permission-mode', 'bypassPermissions']).permissionMode).toBe(
        'bypassPermissions',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Combinations
  // ---------------------------------------------------------------------------

  describe('combined flags', () => {
    it('parses multiple flags together', () => {
      const result = parseArgs([
        '--model', 'claude-3-5-sonnet',
        '--provider', 'anthropic',
        '--max-turns', '3',
        '--verbose',
        '--output-format', 'stream-json',
        'some prompt text',
      ]);

      expect(result.model).toBe('claude-3-5-sonnet');
      expect(result.provider).toBe('anthropic');
      expect(result.maxTurns).toBe(3);
      expect(result.verbose).toBe(true);
      expect(result.outputFormat).toBe('stream-json');
      expect(result.prompt).toBe('some prompt text');
    });

    it('returns empty object (all undefined) when no args provided', () => {
      const result = parseArgs([]);
      expect(result.model).toBeUndefined();
      expect(result.prompt).toBeUndefined();
      expect(result.help).toBeUndefined();
      expect(result.version).toBeUndefined();
      expect(result.continue).toBeUndefined();
    });

    it('equals-form and space-form flags coexist', () => {
      const result = parseArgs(['--model=gpt-4', '--provider', 'openai']);
      expect(result.model).toBe('gpt-4');
      expect(result.provider).toBe('openai');
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown flags
  // ---------------------------------------------------------------------------

  describe('unknown flags', () => {
    it('silently ignores unknown long flags', () => {
      // Should not throw; known flags should still be parsed correctly.
      const result = parseArgs(['--unknown-flag', 'value', '--model', 'test']);
      expect(result.model).toBe('test');
    });

    it('silently ignores unknown short flags', () => {
      const result = parseArgs(['-z', '--model', 'test']);
      expect(result.model).toBe('test');
    });
  });

  // ---------------------------------------------------------------------------
  // --print flag
  // ---------------------------------------------------------------------------

  describe('--print', () => {
    it('sets print to true when flag is present', () => {
      expect(parseArgs(['--print']).print).toBe(true);
    });
  });
});
