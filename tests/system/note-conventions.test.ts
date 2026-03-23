import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  trashNote,
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  findNoteId,
  uniqueTitle,
} from './inspector.js';

const FIXTURE_TEXT = readFileSync(
  resolve(import.meta.dirname, '../fixtures/sample-note.md'),
  'utf-8'
);

const TEST_PREFIX = '[Bear-MCP-stest-note-convention]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('note conventions via MCP Inspector CLI', () => {
  it('convention OFF — tags placed by Bear via URL params', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Conv Off', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: FIXTURE_TEXT, tags: 'system-test' },
        // No env override — convention OFF by default
      });

      noteId = findNoteId(title);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);

      // Bear places tags via URL params — they appear after the title, not embedded at start of text
      // The note body should NOT start with #system-test\n--- (that's the convention ON pattern)
      expect(noteBody).not.toMatch(/^#system-test\n---/);
      // The fixture content should be present in the body
      expect(noteBody).toContain('retention is set to 15 days');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('convention ON — tags embedded in text body with separator', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Conv On Tags+Text', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: FIXTURE_TEXT, tags: 'system-test,system test/system test spaces' },
        env: { UI_ENABLE_CHORUS_CONVENTIONS: 'true' },
      });

      noteId = findNoteId(title);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);

      // Chorus conventions: YAML frontmatter at top, inline tags at bottom, fixture content in body
      expect(noteBody).toContain('---\ntype:');
      expect(noteBody).toContain('tags: [system-test, system test/system test spaces]');
      expect(noteBody).toContain('retention is set to 15 days');
      expect(noteBody).toContain('#system-test');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('convention ON — tags only, no text', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Conv On Tags Only', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, tags: 'system-test' },
        env: { UI_ENABLE_CHORUS_CONVENTIONS: 'true' },
      });

      noteId = findNoteId(title);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);

      // Chorus conventions: YAML frontmatter present even with no text body
      expect(noteBody).toContain('---\ntype:');
      expect(noteBody).toContain('tags: [system-test]');
      expect(noteBody).toContain('#system-test');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('convention ON — no tags, text passes through unchanged', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Conv On No Tags', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: FIXTURE_TEXT },
        env: { UI_ENABLE_CHORUS_CONVENTIONS: 'true' },
      });

      noteId = findNoteId(title);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);

      // No tag line, no separator — just the fixture content
      expect(noteBody).toContain('retention is set to 15 days');
      expect(noteBody).not.toMatch(/#\w+\n---/);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});
