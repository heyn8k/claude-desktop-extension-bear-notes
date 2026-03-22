import { setTimeout } from 'node:timers/promises';

import createDebug from 'debug';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { CORE_DATA_EPOCH_OFFSET } from './config.js';
import { getNoteContent, getNoteRaw, getNoteTags } from './notes.js';
import { buildBearUrl, executeBearXCallbackApi } from './bear-urls.js';
import type { VerificationFailure, VerificationResult } from './types.js';

const VERIFY_POLL_INTERVAL_MS = 25;
const VERIFY_POLL_TIMEOUT_MS = 2_000;

export const logger = {
  debug: createDebug('bear-notes-mcp:debug'),
  info: createDebug('bear-notes-mcp:info'),
  error: createDebug('bear-notes-mcp:error'),
};

// Convert UI_DEBUG_TOGGLE boolean set from UI to DEBUG string for debug package
// MCPB has no way to make this in one step with manifest.json
if (process.env.UI_DEBUG_TOGGLE === 'true') {
  process.env.DEBUG = 'bear-notes-mcp:*';
  logger.debug.enabled = true;
}

// Always enable error and info logs
logger.error.enabled = true;
logger.info.enabled = true;

/**
 * Logs an error message and throws an Error to halt execution.
 * Centralizes error handling to ensure consistent logging before failures.
 *
 * @param message - The error message to log and throw
 * @throws Always throws Error with the provided message
 */
export function logAndThrow(message: string): never {
  logger.error(message);
  throw new Error(message);
}

/**
 * Cleans base64 string by removing whitespace/newlines added by base64 command.
 * URLSearchParams in buildBearUrl will handle URL encoding of special characters.
 *
 * @param base64String - Raw base64 string (may contain whitespace/newlines)
 * @returns Cleaned base64 string without whitespace
 */
export function cleanBase64(base64String: string): string {
  // Remove all whitespace/newlines from base64 (base64 command adds line breaks)
  return base64String.trim().replace(/\s+/g, '');
}

/**
 * Converts Bear's Core Data timestamp to ISO string format.
 * Bear stores timestamps in seconds since Core Data epoch (2001-01-01).
 *
 * @param coreDataTimestamp - Timestamp in seconds since Core Data epoch
 * @returns ISO string representation of the timestamp
 */
export function convertCoreDataTimestamp(coreDataTimestamp: number): string {
  const unixTimestamp = coreDataTimestamp + CORE_DATA_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000).toISOString();
}

/**
 * Converts a JavaScript Date object to Bear's Core Data timestamp format.
 * Core Data timestamps are in seconds since 2001-01-01 00:00:00 UTC.
 *
 * @param date - JavaScript Date object
 * @returns Core Data timestamp in seconds
 */
export function convertDateToCoreDataTimestamp(date: Date): number {
  const unixTimestamp = Math.floor(date.getTime() / 1000);
  return unixTimestamp - CORE_DATA_EPOCH_OFFSET;
}

/**
 * Parses a date string and returns a JavaScript Date object.
 * Supports relative dates ("today", "yesterday", "last week", "last month") and ISO date strings.
 *
 * @param dateString - Date string to parse (e.g., "today", "2024-01-15", "last week")
 * @returns Parsed Date object
 * @throws Error if the date string is invalid
 */
export function parseDateString(dateString: string): Date {
  const lowerDateString = dateString.trim().toLowerCase();
  const now = new Date();

  // Handle relative dates to provide user-friendly natural language date input
  switch (lowerDateString) {
    case 'today': {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      return today;
    }
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      return yesterday;
    }
    case 'last week':
    case 'week ago': {
      const lastWeek = new Date(now);
      lastWeek.setDate(lastWeek.getDate() - 7);
      lastWeek.setHours(0, 0, 0, 0);
      return lastWeek;
    }
    case 'last month':
    case 'month ago':
    case 'start of last month': {
      // Calculate the first day of last month; month arithmetic handles year transitions correctly via JavaScript Date constructor
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      lastMonth.setHours(0, 0, 0, 0);
      return lastMonth;
    }
    case 'end of last month': {
      // Calculate the last day of last month; day 0 of current month equals last day of previous month
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      endOfLastMonth.setHours(23, 59, 59, 999);
      return endOfLastMonth;
    }
    default: {
      // Try parsing as ISO date or other standard formats as fallback for user-provided explicit dates
      const parsed = new Date(dateString);
      if (isNaN(parsed.getTime())) {
        logAndThrow(
          `Invalid date format: "${dateString}". Use ISO format (YYYY-MM-DD) or relative dates (today, yesterday, last week, last month, start of last month, end of last month).`
        );
      }
      return parsed;
    }
  }
}

/**
 * Creates a standardized MCP tool response with consistent formatting.
 * Centralizes response structure to follow DRY principles.
 *
 * @param text - The response text content
 * @returns Formatted CallToolResult for MCP tools
 */
export function createToolResponse(text: string): Pick<CallToolResult, 'content'> {
  return {
    content: [
      {
        type: 'text' as const,
        text,
        annotations: { audience: ['user', 'assistant'] as const },
      },
    ],
  };
}

/**
 * Strips a matching markdown heading from the start of text to prevent header duplication.
 * Bear's add-text API with mode=replace keeps the original section header, so if the
 * replacement text also starts with that header, it appears twice in the note.
 *
 * @param text - The replacement text that may start with a duplicate heading
 * @param header - The cleaned header name (no # prefix) to match against
 * @returns Text with the leading heading removed if it matched, otherwise unchanged
 */
export function stripLeadingHeader(text: string, header: string): string {
  if (!header) return text;

  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadingHeaderRegex = new RegExp(`^#{1,6}\\s+${escaped}\\s*\\n?`, 'i');
  return text.replace(leadingHeaderRegex, '');
}

/**
 * Checks whether a markdown heading matching the given header text exists in the note.
 * Strips markdown prefix from input (e.g., "## Foo" → "Foo") and matches case-insensitively.
 * Escapes regex special characters so headers like "Q&A" or "Details (v2)" match literally.
 */
export function noteHasHeader(noteText: string, header: string): boolean {
  const cleanHeader = header.replace(/^#+\s*/, '');
  const escaped = cleanHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRegex = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'mi');
  return headerRegex.test(noteText);
}

/**
 * Counts occurrences of YAML frontmatter blocks (--- delimited) in a note body.
 * A doubled note will have two frontmatter blocks where one is expected.
 */
function countYamlFrontmatter(text: string): number {
  const matches = text.match(/^---\s*$/gm);
  if (!matches) return 0;
  // Each frontmatter block uses two --- markers; count pairs
  return Math.floor(matches.length / 2);
}

/**
 * Counts H1 headers (lines starting with "# ") in a note body.
 * A doubled note will have duplicate H1 headers.
 */
function countH1Headers(text: string): number {
  const matches = text.match(/^# .+$/gm);
  return matches?.length ?? 0;
}

/**
 * Polls SQLite after a write to verify the note reflects expected changes.
 * Detects three failure modes: doubled content, silent no-op, and tag wipe.
 */
export async function verifyNoteAfterWrite(
  noteId: string,
  preWriteText: string,
  preWriteTags: string[]
): Promise<VerificationResult> {
  const deadline = Date.now() + VERIFY_POLL_TIMEOUT_MS;
  let lastText: string | null = null;

  // Poll until the note text changes or we time out
  while (Date.now() < deadline) {
    const raw = getNoteRaw(noteId);
    if (!raw) {
      return {
        success: false,
        failures: [{ type: 'unchanged', message: 'Note not found after write' }],
      };
    }

    lastText = raw.text;

    // Text changed — stop polling and run checks
    if (lastText !== preWriteText) break;

    await setTimeout(VERIFY_POLL_INTERVAL_MS);
  }

  const failures: VerificationFailure[] = [];

  // Check 1: unchanged (write was a no-op)
  if (lastText === preWriteText) {
    failures.push({
      type: 'unchanged',
      message: 'Note text is unchanged after write — the operation may have been silently ignored',
    });
  }

  // Check 2: doubled content (append-instead-of-replace)
  if (lastText) {
    const yamlCount = countYamlFrontmatter(lastText);
    const h1Count = countH1Headers(lastText);

    if (yamlCount > 1) {
      failures.push({
        type: 'doubled',
        message: `Note contains ${yamlCount} YAML frontmatter blocks (expected 1) — content was likely appended instead of replaced`,
      });
    }
    if (h1Count > 1) {
      failures.push({
        type: 'doubled',
        message: `Note contains ${h1Count} H1 headers (expected 1) — content was likely doubled`,
      });
    }
  }

  // Check 3: tags missing (wipe from full-body replace)
  if (preWriteTags.length > 0) {
    const postWriteTags = getNoteTags(noteId);
    const missing = preWriteTags.filter((t) => !postWriteTags.includes(t));
    if (missing.length > 0) {
      failures.push({
        type: 'tags_missing',
        message: `Tags lost after write: ${missing.map((t) => `#${t}`).join(', ')}`,
      });
    }
  }

  return {
    success: failures.length === 0,
    noteText: lastText ?? undefined,
    failures,
  };
}

/**
 * Checks whether a line is a Bear inline tag line (not a markdown header).
 * Bear tags: #tag, #nested/tag, #multi word tag# — always # then non-space.
 * Markdown headers: # Title — always # then space.
 */
function isTagOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return trimmed.startsWith('#') && trimmed.length > 1 && trimmed[1] !== ' ';
}

/**
 * Strips trailing inline tag lines from a note body.
 * spliceSection() preserves trailing tags for non-last sections, so we strip
 * before re-appending to avoid doubling.
 */
export function stripTrailingTags(body: string): string {
  const lines = body.split('\n');

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || isTagOnlyLine(last)) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join('\n');
}

/**
 * Converts tag names to Bear inline syntax and appends them to body text.
 * Strips any existing trailing tag lines first to prevent doubling.
 */
export function appendTagsToBody(body: string, tags: string[]): string {
  if (tags.length === 0) return body;

  const stripped = stripTrailingTags(body);

  const tagLine = tags
    .map((t) => {
      const needsClosingHash = t.includes(' ');
      return needsClosingHash ? `#${t}#` : `#${t}`;
    })
    .join(' ');

  return `${stripped}\n\n${tagLine}`;
}

/**
 * Splices new section content into a full note body at the position of a given header.
 * Replaces everything between the matched header and the next same-or-higher-level header
 * (or end of document). Handles YAML frontmatter correctly.
 */
export function spliceSection(fullBody: string, header: string, newContent: string): string {
  const cleanHeader = header.replace(/^#+\s*/, '');
  const lines = fullBody.split('\n');

  // Find the target header
  let targetIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (match && match[1].toLowerCase() === cleanHeader.toLowerCase()) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) return fullBody;

  // Find the end of the DIRECT content under this header — stop at the next
  // header of any level. Sub-headers mark the inner boundary, same/higher
  // headers mark sibling/parent boundaries. Both end the direct prose.
  let endIndex = lines.length;
  for (let i = targetIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  // Reconstruct: before + header + blank line + new content + after
  const before = lines.slice(0, targetIndex + 1);
  const after = lines.slice(endIndex);

  return [...before, '', newContent, ...after].join('\n');
}

/**
 * Shared handler for note text operations (append, prepend, or replace).
 * Consolidates common validation, execution, and response logic.
 * After every write, verifies the result via SQLite read-back.
 *
 * @param mode - Whether to append, prepend, or replace text
 * @param params - Note ID, text content, and optional header
 * @returns Formatted response indicating success or failure
 */
export async function handleNoteTextUpdate(
  mode: 'append' | 'prepend' | 'replace',
  { id, text, header }: { id: string; text: string; header?: string | undefined }
): Promise<CallToolResult> {
  const action = mode === 'append' ? 'appended' : mode === 'prepend' ? 'prepended' : 'replaced';
  logger.info(
    `handleNoteTextUpdate(${mode}) id: ${id}, text length: ${text.length}, header: ${header || 'none'}`
  );

  try {
    const existingNote = getNoteContent(id);

    if (!existingNote) {
      return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
    }

    // Snapshot pre-write state for verification
    const preWriteText = existingNote.text ?? '';
    const preWriteTags = getNoteTags(id);

    // Strip markdown header syntax once — reused for both validation and Bear API
    const cleanHeader = header?.replace(/^#+\s*/, '');

    // Bear silently ignores replace-with-header when the section doesn't exist — fail early with a clear message
    if (mode === 'replace' && cleanHeader) {
      if (!existingNote.text || !noteHasHeader(existingNote.text, cleanHeader)) {
        return createToolResponse(`Section "${cleanHeader}" not found in note "${existingNote.title}".

Check the note content with bear-open-note to see available sections.`);
      }
    }

    // Bear's replace mode preserves the original heading (section header or note title),
    // so if the AI includes it in the replacement text, the result has a duplicate.
    let cleanText =
      mode === 'replace' ? stripLeadingHeader(text, cleanHeader || existingNote.title) : text;

    // Determine the Bear API mode to use
    let bearMode: 'append' | 'prepend' | 'replace' | 'replace_all' = mode;
    let bearHeader: string | undefined = cleanHeader;

    if (mode === 'replace') {
      if (cleanHeader && existingNote.text) {
        // All section replaces use splice + replace_all to avoid Bear API quirks:
        // - H1 targets append instead of replacing
        // - Last-section targets consume trailing inline tags
        logger.info('Section replace — using splice + replace_all path');
        const splicedBody = spliceSection(existingNote.text, cleanHeader, cleanText);
        cleanText = appendTagsToBody(splicedBody, preWriteTags);
        bearMode = 'replace_all';
        bearHeader = undefined;
      } else if (!header) {
        // Full-body replace: use replace_all with tag preservation
        cleanText = appendTagsToBody(cleanText, preWriteTags);
        bearMode = 'replace_all';
      }
    }

    const url = buildBearUrl('add-text', {
      id,
      text: cleanText,
      header: bearHeader,
      mode: bearMode,
      // Ensures appended/prepended text starts on its own line, not glued to existing content.
      // Not needed for replace modes — there's no preceding content to separate from.
      new_line: mode !== 'replace' ? 'yes' : undefined,
    });
    logger.debug(`Executing Bear URL: ${url}`);
    await executeBearXCallbackApi(url);

    // Read-after-write verification — the core safety layer
    const verification = await verifyNoteAfterWrite(id, preWriteText, preWriteTags);

    if (!verification.success) {
      const failureDetails = verification.failures.map((f) => `- ${f.message}`).join('\n');
      logger.error(`Verification failed for note ${id}:\n${failureDetails}`);

      return createToolResponse(`Write verification FAILED for note "${existingNote.title}".

The operation was sent to Bear but verification detected problems:

${failureDetails}

Note ID: ${id}
Use bear-open-note to inspect the current state of the note.`);
    }

    const preposition = mode === 'replace' ? 'in' : 'to';
    const responseLines = [
      `Text ${action} ${preposition} note "${existingNote.title}" (verified).`,
      '',
    ];

    responseLines.push(`Text: ${text.length} characters`);

    if (cleanHeader) {
      responseLines.push(`Section: ${cleanHeader}`);
    }

    responseLines.push(`Note ID: ${id}`);

    return createToolResponse(responseLines.join('\n'));
  } catch (error) {
    logger.error(`handleNoteTextUpdate(${mode}) failed: ${error}`);
    throw error;
  }
}
