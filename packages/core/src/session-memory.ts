/**
 * Session memory — in-session learned facts and preferences.
 * Separate from file-based CLAUDE.md; lives alongside the session JSONL.
 */

export interface MemoryEntry {
  key: string;
  value: string;
  category: 'fact' | 'preference' | 'context' | 'tool_state';
  createdAt: string;
  updatedAt: string;
  source: 'user' | 'assistant' | 'tool' | 'system';
  /** Confidence 0-1 */
  confidence: number;
}

export class SessionMemory {
  private entries = new Map<string, MemoryEntry>();
  private maxEntries: number;

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? 100;
  }

  /** Store or update a memory entry. */
  set(
    key: string,
    value: string,
    opts?: Partial<Pick<MemoryEntry, 'category' | 'source' | 'confidence'>>,
  ): void {
    const existing = this.entries.get(key);
    const now = new Date().toISOString();

    this.entries.set(key, {
      key,
      value,
      category: opts?.category ?? existing?.category ?? 'fact',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: opts?.source ?? 'assistant',
      confidence: opts?.confidence ?? 0.8,
    });

    // Evict oldest entries if over limit
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()]
        .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, this.entries.size - this.maxEntries);
      for (const [k] of oldest) this.entries.delete(k);
    }
  }

  /** Get a specific entry. */
  get(key: string): MemoryEntry | null {
    return this.entries.get(key) ?? null;
  }

  /** Delete an entry. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Get all entries, optionally filtered by category. */
  getAll(category?: MemoryEntry['category']): MemoryEntry[] {
    const all = [...this.entries.values()];
    return category ? all.filter(e => e.category === category) : all;
  }

  /** Search entries by keyword in key or value. */
  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return [...this.entries.values()].filter(
      e => e.key.toLowerCase().includes(lower) || e.value.toLowerCase().includes(lower),
    );
  }

  /** Get a summary string for system prompt injection. */
  toPromptContext(): string {
    const entries = this.getAll();
    if (entries.length === 0) return '';

    const lines = entries.map(e => `- ${e.key}: ${e.value}`);
    return `Session context:\n${lines.join('\n')}`;
  }

  /** Serialize to JSON for persistence. */
  serialize(): string {
    return JSON.stringify([...this.entries.values()]);
  }

  /** Restore from serialized JSON. */
  static deserialize(json: string): SessionMemory {
    const memory = new SessionMemory();
    try {
      const entries = JSON.parse(json) as MemoryEntry[];
      for (const entry of entries) {
        memory.entries.set(entry.key, entry);
      }
    } catch {
      // Silently ignore malformed JSON — return empty memory
    }
    return memory;
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }
}
