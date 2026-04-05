import { describe, expect, it } from 'bun:test';
import { createBashTool } from '../bash.js';
import { createReadTool } from '../read.js';
import { createWriteTool } from '../write.js';
import { createEditTool } from '../edit.js';
import { createGlobTool } from '../glob.js';
import { createGrepTool } from '../grep.js';
import { createWebFetchTool } from '../web-fetch.js';
import { createWebSearchTool } from '../web-search.js';
import { createNotebookEditTool } from '../notebook-edit.js';

describe('built-in tool annotations', () => {
  describe('Bash', () => {
    it('is destructive and openWorld', () => {
      const tool = createBashTool();
      expect(tool.annotations?.destructive).toBe(true);
      expect(tool.annotations?.openWorld).toBe(true);
    });

    it('does not set readOnly', () => {
      const tool = createBashTool();
      expect(tool.annotations?.readOnly).toBeUndefined();
    });
  });

  describe('Read', () => {
    it('is readOnly and idempotent', () => {
      const tool = createReadTool();
      expect(tool.annotations?.readOnly).toBe(true);
      expect(tool.annotations?.idempotent).toBe(true);
    });

    it('does not set destructive', () => {
      const tool = createReadTool();
      expect(tool.annotations?.destructive).toBeUndefined();
    });
  });

  describe('Write', () => {
    it('is destructive', () => {
      const tool = createWriteTool();
      expect(tool.annotations?.destructive).toBe(true);
    });

    it('does not set readOnly', () => {
      const tool = createWriteTool();
      expect(tool.annotations?.readOnly).toBeUndefined();
    });
  });

  describe('Edit', () => {
    it('is destructive', () => {
      const tool = createEditTool();
      expect(tool.annotations?.destructive).toBe(true);
    });

    it('does not set readOnly', () => {
      const tool = createEditTool();
      expect(tool.annotations?.readOnly).toBeUndefined();
    });
  });

  describe('Glob', () => {
    it('is readOnly and idempotent', () => {
      const tool = createGlobTool();
      expect(tool.annotations?.readOnly).toBe(true);
      expect(tool.annotations?.idempotent).toBe(true);
    });
  });

  describe('Grep', () => {
    it('is readOnly and idempotent', () => {
      const tool = createGrepTool();
      expect(tool.annotations?.readOnly).toBe(true);
      expect(tool.annotations?.idempotent).toBe(true);
    });
  });

  describe('WebFetch', () => {
    it('is readOnly and openWorld', () => {
      const tool = createWebFetchTool();
      expect(tool.annotations?.readOnly).toBe(true);
      expect(tool.annotations?.openWorld).toBe(true);
    });

    it('does not set destructive', () => {
      const tool = createWebFetchTool();
      expect(tool.annotations?.destructive).toBeUndefined();
    });
  });

  describe('WebSearch', () => {
    it('is readOnly and openWorld', () => {
      const tool = createWebSearchTool();
      expect(tool.annotations?.readOnly).toBe(true);
      expect(tool.annotations?.openWorld).toBe(true);
    });
  });

  describe('NotebookEdit', () => {
    it('is destructive', () => {
      const tool = createNotebookEditTool();
      expect(tool.annotations?.destructive).toBe(true);
    });

    it('does not set readOnly', () => {
      const tool = createNotebookEditTool();
      expect(tool.annotations?.readOnly).toBeUndefined();
    });
  });
});
