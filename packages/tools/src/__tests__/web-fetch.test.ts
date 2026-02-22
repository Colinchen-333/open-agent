import { describe, it, expect } from 'bun:test';
import { htmlToMarkdown } from '../web-fetch.js';

describe('htmlToMarkdown', () => {
  // ---------------------------------------------------------------------------
  // Headings
  // ---------------------------------------------------------------------------

  describe('headings', () => {
    it('converts <h1> to # heading', () => {
      const result = htmlToMarkdown('<h1>Title</h1>');
      expect(result).toContain('# Title');
    });

    it('converts <h2> to ## heading', () => {
      const result = htmlToMarkdown('<h2>Section</h2>');
      expect(result).toContain('## Section');
    });

    it('converts <h3> to ### heading', () => {
      const result = htmlToMarkdown('<h3>Subsection</h3>');
      expect(result).toContain('### Subsection');
    });
  });

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  describe('links', () => {
    it('converts <a href="url">text</a> to [text](url)', () => {
      const result = htmlToMarkdown('<a href="https://example.com">Example</a>');
      expect(result).toContain('[Example](https://example.com)');
    });

    it('uses the href as fallback when anchor has no visible text', () => {
      const result = htmlToMarkdown('<a href="https://example.com"></a>');
      expect(result).toContain('https://example.com');
    });

    it('strips inner tags from anchor label', () => {
      const result = htmlToMarkdown('<a href="https://example.com"><strong>Bold Link</strong></a>');
      expect(result).toContain('[Bold Link](https://example.com)');
    });
  });

  // ---------------------------------------------------------------------------
  // Inline formatting
  // ---------------------------------------------------------------------------

  describe('inline formatting', () => {
    it('converts <strong> to **bold**', () => {
      const result = htmlToMarkdown('<strong>bold text</strong>');
      expect(result).toContain('**bold text**');
    });

    it('converts <b> to **bold**', () => {
      const result = htmlToMarkdown('<b>also bold</b>');
      expect(result).toContain('**also bold**');
    });

    it('converts <em> to *italic*', () => {
      const result = htmlToMarkdown('<em>italic text</em>');
      expect(result).toContain('*italic text*');
    });

    it('converts <i> to *italic*', () => {
      const result = htmlToMarkdown('<i>also italic</i>');
      expect(result).toContain('*also italic*');
    });

    it('converts <code> to backtick-wrapped text', () => {
      const result = htmlToMarkdown('<code>console.log()</code>');
      expect(result).toContain('`console.log()`');
    });
  });

  // ---------------------------------------------------------------------------
  // Code blocks
  // ---------------------------------------------------------------------------

  describe('code blocks', () => {
    it('converts <pre> to fenced code block', () => {
      const result = htmlToMarkdown('<pre>function foo() {}</pre>');
      expect(result).toContain('```');
      expect(result).toContain('function foo() {}');
    });

    it('strips inner <code> tag inside <pre>', () => {
      const result = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
      expect(result).toContain('```');
      expect(result).toContain('const x = 1;');
      // Should not contain the raw <code> tag
      expect(result).not.toContain('<code>');
    });
  });

  // ---------------------------------------------------------------------------
  // Script and style stripping
  // ---------------------------------------------------------------------------

  describe('script and style stripping', () => {
    it('strips <script> tags and their content entirely', () => {
      const result = htmlToMarkdown(
        '<p>Visible</p><script>alert("xss")</script><p>Also visible</p>',
      );
      expect(result).not.toContain('alert');
      expect(result).not.toContain('<script>');
      expect(result).toContain('Visible');
      expect(result).toContain('Also visible');
    });

    it('strips <style> tags and their content entirely', () => {
      const result = htmlToMarkdown(
        '<style>body { color: red; }</style><p>Content</p>',
      );
      expect(result).not.toContain('color: red');
      expect(result).not.toContain('<style>');
      expect(result).toContain('Content');
    });

    it('strips multi-line <script> blocks', () => {
      const html = `
        <p>Before</p>
        <script type="text/javascript">
          const secret = "hidden";
          doSomething();
        </script>
        <p>After</p>
      `;
      const result = htmlToMarkdown(html);
      expect(result).not.toContain('secret');
      expect(result).not.toContain('doSomething');
      expect(result).toContain('Before');
      expect(result).toContain('After');
    });
  });

  // ---------------------------------------------------------------------------
  // HTML entity decoding
  // ---------------------------------------------------------------------------

  describe('entity decoding', () => {
    it('decodes &amp; to &', () => {
      const result = htmlToMarkdown('Tom &amp; Jerry');
      expect(result).toContain('Tom & Jerry');
    });

    it('decodes &lt; to <', () => {
      const result = htmlToMarkdown('a &lt; b');
      expect(result).toContain('a < b');
    });

    it('decodes &gt; to >', () => {
      const result = htmlToMarkdown('a &gt; b');
      expect(result).toContain('a > b');
    });

    it('decodes &quot; to "', () => {
      const result = htmlToMarkdown('He said &quot;hello&quot;');
      expect(result).toContain('He said "hello"');
    });

    it("decodes &#39; to '", () => {
      const result = htmlToMarkdown("It&#39;s a test");
      expect(result).toContain("It's a test");
    });

    it('decodes &nbsp; to space', () => {
      const result = htmlToMarkdown('word&nbsp;gap');
      expect(result).toContain('word gap');
    });

    it('decodes multiple entities in one string', () => {
      const result = htmlToMarkdown('&lt;div&gt; &amp; &lt;/div&gt;');
      expect(result).toContain('<div> & </div>');
    });
  });

  // ---------------------------------------------------------------------------
  // Newline collapsing
  // ---------------------------------------------------------------------------

  describe('multiple newline collapsing', () => {
    it('collapses 3+ newlines to at most 2', () => {
      // Paragraphs generate double newlines; many in sequence should be capped.
      const html = '<p>A</p><p>B</p><p>C</p>';
      const result = htmlToMarkdown(html);
      // After trimming, there should be no runs of 3+ newlines.
      expect(result).not.toMatch(/\n{3,}/);
    });

    it('preserves meaningful double-newlines between paragraphs', () => {
      const result = htmlToMarkdown('<p>First paragraph</p><p>Second paragraph</p>');
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
    });
  });

  // ---------------------------------------------------------------------------
  // Remaining tag stripping
  // ---------------------------------------------------------------------------

  describe('remaining HTML tag stripping', () => {
    it('strips unknown tags leaving their text content', () => {
      const result = htmlToMarkdown('<div><span>Hello</span></div>');
      expect(result).toContain('Hello');
      expect(result).not.toContain('<div>');
      expect(result).not.toContain('<span>');
    });

    it('strips HTML attributes from tags', () => {
      const result = htmlToMarkdown('<p class="intro" id="main">Paragraph</p>');
      expect(result).toContain('Paragraph');
      expect(result).not.toContain('class=');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      const result = htmlToMarkdown('');
      expect(result).toBe('');
    });

    it('handles plain text with no HTML tags', () => {
      const result = htmlToMarkdown('Just plain text');
      expect(result).toBe('Just plain text');
    });

    it('trims leading and trailing whitespace', () => {
      const result = htmlToMarkdown('  <p>Hello</p>  ');
      expect(result).not.toMatch(/^\s/);
      expect(result).not.toMatch(/\s$/);
    });

    it('converts list items to markdown bullets', () => {
      const result = htmlToMarkdown('<ul><li>First</li><li>Second</li></ul>');
      expect(result).toContain('- First');
      expect(result).toContain('- Second');
    });

    it('converts line breaks to newlines', () => {
      const result = htmlToMarkdown('Line one<br>Line two');
      expect(result).toContain('Line one\nLine two');
    });
  });
});
