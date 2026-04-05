export interface FrontmatterParseResult {
  frontmatter: Record<string, string | boolean | number | string[]>;
  body: string;
}

/**
 * Parse a markdown document with optional YAML-like frontmatter.
 * Frontmatter begins with a line containing exactly `---` and ends with the
 * next line containing exactly `---`. If no frontmatter is present, returns
 * an empty object for `frontmatter` and the full input as `body`.
 *
 * Supports:
 *   key: value             → string
 *   key: true | false      → boolean
 *   key: 42                → number
 *   key: [a, b, c]         → string array
 *   key: - a\n   - b       → string array (YAML block form)
 *
 * Does NOT support nested objects or multi-line strings.
 */
export function parseFrontmatter(input: string): FrontmatterParseResult {
  // Normalise line endings
  const text = input.replace(/\r\n/g, '\n');

  // Frontmatter must start with `---` on the very first line
  if (!text.startsWith('---\n') && text !== '---') {
    return { frontmatter: {}, body: input };
  }

  // Find the closing `---`
  const afterOpen = text.slice(4); // skip "---\n"
  const closeIdx = afterOpen.indexOf('\n---\n');
  const closeAtEnd = afterOpen.endsWith('\n---');

  if (closeIdx === -1 && !closeAtEnd) {
    // No closing delimiter found — treat everything as body
    return { frontmatter: {}, body: input };
  }

  const fmContent = closeIdx !== -1
    ? afterOpen.slice(0, closeIdx)
    : afterOpen.slice(0, afterOpen.lastIndexOf('\n---'));

  const bodyStart = closeIdx !== -1
    ? 4 + closeIdx + 5 // "---\n" + fmContent + "\n---\n"
    : text.length;     // nothing after trailing `---`

  const body = text.slice(bodyStart);

  // Parse the frontmatter lines
  const frontmatter: Record<string, string | boolean | number | string[]> = {};
  const lines = fmContent.split('\n');
  let currentKey: string | null = null;
  let blockList: string[] | null = null;

  const flushBlockList = () => {
    if (currentKey !== null && blockList !== null) {
      frontmatter[currentKey] = blockList;
      blockList = null;
      currentKey = null;
    }
  };

  for (const line of lines) {
    // Skip comment lines
    if (/^\s*#/.test(line)) continue;

    // Skip blank lines (but do not flush a block list — blank lines are allowed
    // inside block sequences before the next item)
    if (line.trim() === '') continue;

    // Block sequence item: lines starting with optional whitespace then "- "
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && currentKey !== null) {
      if (!blockList) blockList = [];
      blockList.push(listItemMatch[1].replace(/^['"]|['"]$/g, '').trim());
      continue;
    }

    // Starting a new key — flush any pending block list first
    flushBlockList();

    // Key-value pair: allow hyphens and dots in key names to support common
    // frontmatter patterns, but keep it simple (no nested keys)
    const kvMatch = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (value === '') {
      // Empty value — expect a block sequence on subsequent lines
      currentKey = key;
      blockList = [];
    } else if (value === 'true') {
      frontmatter[key] = true;
    } else if (value === 'false') {
      frontmatter[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      frontmatter[key] = Number(value);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Inline array: [a, b, c]
      frontmatter[key] = value
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(s => s.length > 0);
    } else {
      // Plain string — strip surrounding quotes if present
      frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  // Flush any trailing block list
  flushBlockList();

  return { frontmatter, body };
}
