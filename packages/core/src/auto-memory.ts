import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * AutoMemory provides persistent per-project memory storage under
 * ~/.open-agent/projects/<encoded-cwd>/memory/.
 *
 * The primary file is MEMORY.md. Additional topic files can be stored
 * alongside it as <topic>.md for more granular persistence.
 */
export class AutoMemory {
  private baseDir: string;

  constructor(cwd: string) {
    // Encode cwd into a safe directory name by replacing slashes with dashes
    const safePath = cwd.replace(/\//g, '-').replace(/^-/, '');
    this.baseDir = join(homedir(), '.open-agent', 'projects', safePath, 'memory');
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Read the main MEMORY.md file. Returns empty string if it does not exist. */
  readMemory(): string {
    const memoryPath = join(this.baseDir, 'MEMORY.md');
    if (!existsSync(memoryPath)) return '';
    return readFileSync(memoryPath, 'utf-8');
  }

  /** Overwrite the main MEMORY.md file with the given content. */
  writeMemory(content: string): void {
    writeFileSync(join(this.baseDir, 'MEMORY.md'), content, 'utf-8');
  }

  /** Read a named topic file (<topic>.md). Returns empty string if absent. */
  readTopic(topic: string): string {
    const topicPath = join(this.baseDir, `${topic}.md`);
    if (!existsSync(topicPath)) return '';
    return readFileSync(topicPath, 'utf-8');
  }

  /** Write (overwrite) a named topic file (<topic>.md). */
  writeTopic(topic: string, content: string): void {
    writeFileSync(join(this.baseDir, `${topic}.md`), content, 'utf-8');
  }

  /** Return the absolute path of the memory directory. */
  getDir(): string {
    return this.baseDir;
  }

  /**
   * List all topic names (files ending in .md, excluding MEMORY.md).
   * Returns an empty array if the directory does not exist.
   */
  listTopics(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .map((f) => f.replace(/\.md$/, ''));
  }
}
