import { basename } from 'path';

export function truncateSummary(text: string, maxLength: number = 50): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function summarizeFilePath(filePath?: string): string | null {
  return typeof filePath === 'string' && filePath.length > 0 ? basename(filePath) : null;
}

export function summarizeCommand(command?: string, description?: string): string {
  const source = description?.trim() || command?.trim() || 'shell command';
  return truncateSummary(source, 50);
}
