/**
 * NDJSON-safe JSON.stringify. Escapes U+2028/U+2029 line separators
 * so serialized output cannot be broken by line-splitting receivers.
 *
 * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are valid
 * inside JSON strings but act as line terminators in JavaScript source.
 * An NDJSON consumer that splits on `\n` will not break, but one that
 * uses a JS-level line iterator may see a premature line boundary.
 * Replacing them with their `\uXXXX` escape sequences is safe for all
 * JSON parsers and eliminates the ambiguity.
 */
export function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}
