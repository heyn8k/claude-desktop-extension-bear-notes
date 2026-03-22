#!/usr/bin/env node
import { setTimeout as wait } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { APP_VERSION, ENABLE_CHORUS_CONVENTIONS, ENABLE_CONTENT_REPLACEMENT } from './config.js';
import { applyChorusConventions, validateChorusStructure } from './note-conventions.js';
import {
  appendTagsToBody,
  cleanBase64,
  createToolResponse,
  handleNoteTextUpdate,
  logger,
  stripLeadingHeader,
  verifyNoteAfterWrite,
} from './utils.js';
import {
  awaitNoteCreation,
  getNoteContent,
  getNoteRaw,
  getNoteTags,
  isNoteArchived,
  noteFileExists,
  searchNotes,
  tagExists,
} from './notes.js';
import { findUntaggedNotes, listTags } from './tags.js';
import { buildBearUrl, executeBearXCallbackApi } from './bear-urls.js';
import type { BearTag } from './types.js';

const server = new McpServer(
  {
    name: 'bear-notes-mcp',
    version: APP_VERSION,
  },
  {
    instructions: [
      'This server integrates with Bear, a markdown note-taking app.',
      'Each note has a unique ID, a title, a body, and optional tags.',
      'Notes use markdown headings (##, ###, etc.) to define sections.',
      'Use bear-search-notes to find note IDs before reading or modifying notes.',
      'To modify note content: bear-add-text inserts text without touching existing content; bear-replace-text overwrites content.',
      'When targeting a section by header, operations apply only to the direct content under that header — not nested sub-sections.',
      'To modify sub-sections, make separate calls targeting each sub-header.',
      'Destructive operations (replace, archive, trash, tag delete, tag rename, full-note upsert) require explicit user intent — never perform these speculatively.',
      'Always prefer note IDs over title matching. Never use title matching for destructive operations when an ID is available.',
      'When replacing note content, read the note first to confirm you are targeting the correct note.',
    ].join('\n'),
  }
);

server.registerTool(
  'bear-open-note',
  {
    title: 'Open Bear Note',
    description:
      'Read the full text content of a Bear note from your library. Always includes text extracted from attached images and PDFs (aka OCR search) with clear labeling.',
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Exact note identifier (ID) obtained from bear-search-notes'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }): Promise<CallToolResult> => {
    logger.info(`bear-open-note called with id: ${id}, includeFiles: always`);

    try {
      const noteWithContent = getNoteContent(id);

      if (!noteWithContent) {
        return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
      }

      const noteInfo = [
        `**${noteWithContent.title}**`,
        `Modified: ${noteWithContent.modification_date}`,
        `ID: ${noteWithContent.identifier}`,
      ];

      const noteText = noteWithContent.text || '*This note appears to be empty.*';
      const annotations = { audience: ['user', 'assistant'] as ('user' | 'assistant')[] };

      // Body and file metadata are separate content blocks so the synthetic
      // file section can never leak back during write operations (#86)
      const content: CallToolResult['content'] = [
        {
          type: 'text' as const,
          text: `${noteInfo.join('\n')}\n\n---\n\n${noteText}`,
          annotations,
        },
      ];

      if (noteWithContent.files?.length) {
        const fileEntries = noteWithContent.files
          .map((f) => `## ${f.filename}\n\n${f.content}`)
          .join('\n\n---\n\n');
        content.push({
          type: 'text' as const,
          text: `# Attached Files\n\n${fileEntries}`,
          annotations,
        });
      }

      return { content };
    } catch (error) {
      logger.error('bear-open-note failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-create-note',
  {
    title: 'Create New Note',
    description:
      'Create a new note in your Bear library with optional title, content, and tags. Returns the note ID when a title is provided, enabling immediate follow-up operations. The note will be immediately available in Bear app.',
    inputSchema: {
      title: z
        .string()
        .trim()
        .optional()
        .describe('Note title, e.g., "Meeting Notes" or "Research Ideas"'),
      text: z
        .string()
        .trim()
        .optional()
        .describe(
          'Note content in markdown format. Do not include a title heading — Bear adds it automatically from the title parameter.'
        ),
      tags: z
        .string()
        .trim()
        .optional()
        .describe('Tags separated by commas, e.g., "work,project,urgent"'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ title, text, tags }): Promise<CallToolResult> => {
    try {
      const { text: createText, tags: createTags } = ENABLE_CHORUS_CONVENTIONS
        ? applyChorusConventions({ text, tags, title })
        : { text, tags };

      // When Chorus conventions are on, the H1 is already in createText — don't also
      // pass title to Bear or it adds a second H1 above the body.
      const url = buildBearUrl('create', {
        title: ENABLE_CHORUS_CONVENTIONS ? undefined : title,
        text: createText,
        tags: createTags,
      });

      await executeBearXCallbackApi(url);

      // Poll for the note ID — extract from conventions output if needed
      const h1Match = createText?.match(/^#\s+(.+?)\s*$/m);
      const pollTitle = title || h1Match?.[1];
      const createdNoteId = pollTitle ? await awaitNoteCreation(pollTitle) : undefined;

      if (createdNoteId) {
        const createdNote = getNoteContent(createdNoteId);
        const responseLines: string[] = ['Note created (verified).', ''];
        responseLines.push(`Title: "${createdNote?.title}"`);
        if (tags) responseLines.push(`Tags: ${tags}`);
        responseLines.push(`Note ID: ${createdNoteId}`);
        return createToolResponse(responseLines.join('\n'));
      }

      // Fallback: create was dispatched but ID not recoverable for verification
      const responseLines: string[] = [
        'Note created (unverified — could not recover note ID).',
        'Use bear-search-notes to confirm.',
        '',
      ];
      if (title) responseLines.push(`Title: "${title}"`);
      if (tags) responseLines.push(`Tags: ${tags}`);
      return createToolResponse(responseLines.join('\n'));
    } catch (error) {
      logger.error('bear-create-note failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-search-notes',
  {
    title: 'Find Bear Notes',
    description:
      'Find notes in your Bear library by searching text content, filtering by tags, or date ranges. Always searches within attached images and PDF files via OCR. Returns a list with titles and IDs - use "Open Bear Note" to read full content.',
    inputSchema: {
      term: z.string().trim().optional().describe('Text to search for in note titles and content'),
      tag: z.string().trim().optional().describe('Tag to filter notes by (without # symbol)'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 50)'),
      createdAfter: z
        .string()
        .optional()
        .describe(
          'Filter notes created on or after this date. Supports: relative dates ("today", "yesterday", "last week", "start of last month"), ISO format (YYYY-MM-DD). Use "start of last month" for the beginning of the previous month.'
        ),
      createdBefore: z
        .string()
        .optional()
        .describe(
          'Filter notes created on or before this date. Supports: relative dates ("today", "yesterday", "last week", "end of last month"), ISO format (YYYY-MM-DD). Use "end of last month" for the end of the previous month.'
        ),
      modifiedAfter: z
        .string()
        .optional()
        .describe(
          'Filter notes modified on or after this date. Supports: relative dates ("today", "yesterday", "last week", "start of last month"), ISO format (YYYY-MM-DD). Use "start of last month" for the beginning of the previous month.'
        ),
      modifiedBefore: z
        .string()
        .optional()
        .describe(
          'Filter notes modified on or before this date. Supports: relative dates ("today", "yesterday", "last week", "end of last month"), ISO format (YYYY-MM-DD). Use "end of last month" for the end of the previous month.'
        ),
      pinned: z
        .boolean()
        .optional()
        .describe(
          'Set to true to return only pinned notes: if combined with tag, will return pinned notes with that tag, otherwise only globally pinned notes.'
        ),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    term,
    tag,
    limit,
    createdAfter,
    createdBefore,
    modifiedAfter,
    modifiedBefore,
    pinned,
  }): Promise<CallToolResult> => {
    logger.info(
      `bear-search-notes called with term: "${term || 'none'}", tag: "${tag || 'none'}", limit: ${limit || 'default'}, createdAfter: "${createdAfter || 'none'}", createdBefore: "${createdBefore || 'none'}", modifiedAfter: "${modifiedAfter || 'none'}", modifiedBefore: "${modifiedBefore || 'none'}", pinned: ${pinned ?? 'none'}, includeFiles: always`
    );

    try {
      const dateFilter = {
        ...(createdAfter && { createdAfter }),
        ...(createdBefore && { createdBefore }),
        ...(modifiedAfter && { modifiedAfter }),
        ...(modifiedBefore && { modifiedBefore }),
      };

      const { notes, totalCount } = searchNotes(
        term,
        tag,
        limit,
        Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        pinned
      );

      if (notes.length === 0) {
        const searchCriteria = [];
        if (term) searchCriteria.push(`term "${term}"`);
        if (tag) searchCriteria.push(`tag "${tag}"`);
        if (createdAfter) searchCriteria.push(`created after "${createdAfter}"`);
        if (createdBefore) searchCriteria.push(`created before "${createdBefore}"`);
        if (modifiedAfter) searchCriteria.push(`modified after "${modifiedAfter}"`);
        if (modifiedBefore) searchCriteria.push(`modified before "${modifiedBefore}"`);
        if (pinned) searchCriteria.push('pinned only');

        return createToolResponse(`No notes found matching ${searchCriteria.join(', ')}.

Try different search criteria or check if notes exist in Bear Notes.`);
      }

      // Show total count when results are truncated
      const hasMore = totalCount > notes.length;
      const countDisplay = hasMore
        ? `${notes.length} notes (${totalCount} total matching)`
        : `${notes.length} note${notes.length === 1 ? '' : 's'}`;

      const resultLines = [`Found ${countDisplay}:`, ''];

      notes.forEach((note, index) => {
        const noteTitle = note.title || 'Untitled';
        const modifiedDate = new Date(note.modification_date).toLocaleDateString();
        const createdDate = new Date(note.creation_date).toLocaleDateString();

        resultLines.push(`${index + 1}. **${noteTitle}**`);
        resultLines.push(`   Created: ${createdDate}`);
        resultLines.push(`   Modified: ${modifiedDate}`);
        resultLines.push(`   ID: ${note.identifier}`);
        resultLines.push('');
      });

      resultLines.push('Use bear-open-note with an ID to read the full content of any note.');

      if (hasMore) {
        resultLines.push(`Use bear-search-notes with limit: ${totalCount} to get all results.`);
      }

      return createToolResponse(resultLines.join('\n'));
    } catch (error) {
      logger.error('bear-search-notes failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-add-text',
  {
    title: 'Add Text to Note',
    description:
      'Insert text at the beginning or end of a Bear note, or within a specific section identified by its header. Use bear-search-notes first to get the note ID. To insert without replacing existing text use this tool; to overwrite the direct content under a header use bear-replace-text.',
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes'),
      text: z
        .string()
        .trim()
        .min(1, 'Text content is required')
        .describe('Text content to add to the note'),
      header: z
        .string()
        .trim()
        .optional()
        .describe(
          'Optional section header to target (adds text within that section). Accepts any heading level, including the note title (H1).'
        ),
      position: z
        .enum(['beginning', 'end'])
        .optional()
        .describe(
          "Where to insert: 'end' (default) for appending, logs, updates; 'beginning' for prepending, summaries, top of mind, etc."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ id, text, header, position }): Promise<CallToolResult> => {
    const mode = position === 'beginning' ? 'prepend' : 'append';
    return handleNoteTextUpdate(mode, { id, text, header });
  }
);

server.registerTool(
  'bear-replace-text',
  {
    title: 'Replace Note Content',
    description:
      'Replace content in an existing Bear note — either the full body or a specific section. Requires content replacement to be enabled in extension settings. Use bear-search-notes first to get the note ID. To add text without replacing existing content use bear-add-text instead.',
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes'),
      scope: z
        .enum(['section', 'full-note-body'])
        .describe(
          "Replacement target: 'section' replaces under a specific header (requires header), 'full-note-body' replaces the entire note body (header must not be set)"
        ),
      text: z
        .string()
        .trim()
        .min(1, 'Text content is required')
        .describe(
          'Replacement text content. When scope is "section", provide only the direct content for the targeted header — do not include markdown sub-headers (###). Replace sub-sections with separate calls targeting each sub-header.'
        ),
      header: z
        .string()
        .trim()
        .optional()
        .describe(
          'Section header to target — required when scope is "section", forbidden when scope is "full-note-body". Accepts any heading level, including the note title (H1).'
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id, scope, text, header }): Promise<CallToolResult> => {
    if (!ENABLE_CONTENT_REPLACEMENT) {
      return createToolResponse(`Content replacement is not enabled.

To use replace mode, enable "Content Replacement" in the Bear Notes extension settings.`);
    }

    if (scope === 'section' && !header) {
      return createToolResponse(`scope is "section" but no header was provided.

Set the header parameter to the section heading you want to replace.`);
    }

    if (scope === 'full-note-body' && header) {
      return createToolResponse(`scope is "full-note-body" but a header was provided.

Remove the header parameter to replace the full note body, or change scope to "section".`);
    }

    return handleNoteTextUpdate('replace', { id, text, header });
  }
);

server.registerTool(
  'bear-add-file',
  {
    title: 'Add File to Note',
    description:
      'Attach a file to an existing Bear note. Encode the file to base64 using shell commands (e.g., base64 /path/to/file.xlsx) and provide the encoded content. Use bear-search-notes first to get the note ID.',
    inputSchema: {
      base64_content: z
        .string()
        .trim()
        .min(1, 'Base64 file content is required')
        .describe('Base64-encoded file content'),
      filename: z
        .string()
        .trim()
        .min(1, 'Filename is required')
        .describe('Filename with extension (e.g., budget.xlsx, report.pdf)'),
      id: z
        .string()
        .trim()
        .optional()
        .describe('Exact note identifier (ID) obtained from bear-search-notes'),
      title: z.string().trim().optional().describe('Note title if ID is not available'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ base64_content, filename, id, title }): Promise<CallToolResult> => {
    logger.info(
      `bear-add-file called with base64_content: ${base64_content ? 'provided' : 'none'}, filename: ${filename || 'none'}, id: ${id || 'none'}, title: ${title || 'none'}`
    );

    if (!id && !title) {
      throw new Error(
        'Either note ID or title is required. Use bear-search-notes to find the note ID.'
      );
    }

    try {
      // base64 CLI adds line breaks that break URL encoding
      const cleanedBase64 = cleanBase64(base64_content);

      // Resolve to an ID for both validation and verification
      let resolvedId = id;

      if (id) {
        const existingNote = getNoteContent(id);
        if (!existingNote) {
          return createToolResponse(
            `Note with ID '${id}' not found.\n\nUse bear-search-notes to find the correct identifier.`
          );
        }
      } else if (title) {
        // Pre-resolve title to ID using the same pattern as bear-upsert-note
        const { notes } = searchNotes(title, undefined, 10_000);
        const exactMatches = notes.filter((n) => n.title.toLowerCase() === title.toLowerCase());

        if (exactMatches.length === 1) {
          resolvedId = exactMatches[0].identifier;
        } else if (exactMatches.length > 1) {
          const matchList = exactMatches
            .map((n) => `- "${n.title}" (ID: ${n.identifier})`)
            .join('\n');
          return createToolResponse(
            `Multiple notes match title "${title}". Specify by ID:\n\n${matchList}`
          );
        }
        // If zero matches, let Bear try the title path — it may still work
      }

      const url = buildBearUrl('add-file', {
        id: resolvedId,
        title: resolvedId ? undefined : title,
        file: cleanedBase64,
        filename,
        mode: 'append',
      });

      await executeBearXCallbackApi(url);

      const noteIdentifier = resolvedId ? `Note ID: ${resolvedId}` : `Note title: "${title!}"`;

      // Verify the file attachment via SQLite when we have an ID
      if (resolvedId) {
        const deadline = Date.now() + 2_000;

        while (Date.now() < deadline) {
          if (noteFileExists(resolvedId, filename)) {
            return createToolResponse(`File "${filename}" added (verified).\n\n${noteIdentifier}`);
          }
          await wait(25);
        }

        return createToolResponse(
          `File add sent but verification failed — "${filename}" not yet in database.\n\n${noteIdentifier}\nCheck Bear manually.`
        );
      }

      return createToolResponse(
        `File "${filename}" added (unverified — could not resolve note ID).\n\n${noteIdentifier}`
      );
    } catch (error) {
      logger.error('bear-add-file failed:', error);
      throw error;
    }
  }
);

/**
 * Formats tag hierarchy as tree-style text output.
 * Uses box-drawing characters for visual tree structure.
 */
function formatTagTree(tags: BearTag[], isLast: boolean[] = []): string[] {
  const lines: string[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const isLastItem = i === tags.length - 1;

    // Build the prefix using box-drawing characters
    let linePrefix = '';
    for (let j = 0; j < isLast.length; j++) {
      linePrefix += isLast[j] ? '    ' : '│   ';
    }
    linePrefix += isLastItem ? '└── ' : '├── ';

    lines.push(`${linePrefix}${tag.name} (${tag.noteCount})`);

    if (tag.children.length > 0) {
      lines.push(...formatTagTree(tag.children, [...isLast, isLastItem]));
    }
  }

  return lines;
}

server.registerTool(
  'bear-list-tags',
  {
    title: 'List Bear Tags',
    description:
      'List all tags in your Bear library as a hierarchical tree. Shows tag names with note counts. Useful for understanding your tag structure and finding tags to apply to untagged notes.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (): Promise<CallToolResult> => {
    logger.info('bear-list-tags called');

    try {
      const { tags, totalCount } = listTags();

      if (totalCount === 0) {
        return createToolResponse('No tags found in your Bear library.');
      }

      // Format root tags with their children as trees
      const lines: string[] = [];
      for (const rootTag of tags) {
        lines.push(`${rootTag.name} (${rootTag.noteCount})`);
        if (rootTag.children.length > 0) {
          lines.push(...formatTagTree(rootTag.children));
        }
      }

      const header = `Found ${totalCount} tag${totalCount === 1 ? '' : 's'}:\n`;

      return createToolResponse(header + '\n' + lines.join('\n'));
    } catch (error) {
      logger.error('bear-list-tags failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-find-untagged-notes',
  {
    title: 'Find Untagged Notes',
    description:
      'Find notes in your Bear library that have no tags. Useful for organizing and categorizing notes.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum number of results (default: 50)'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ limit }): Promise<CallToolResult> => {
    logger.info(`bear-find-untagged-notes called with limit: ${limit || 'default'}`);

    try {
      const { notes, totalCount } = findUntaggedNotes(limit);

      if (notes.length === 0) {
        return createToolResponse('No untagged notes found. All your notes have tags!');
      }

      // Show total count when results are truncated
      const hasMore = totalCount > notes.length;
      const countDisplay = hasMore
        ? `${notes.length} untagged notes (${totalCount} total)`
        : `${notes.length} untagged note${notes.length === 1 ? '' : 's'}`;

      const lines = [`Found ${countDisplay}:`, ''];

      notes.forEach((note, index) => {
        const modifiedDate = new Date(note.modification_date).toLocaleDateString();
        lines.push(`${index + 1}. **${note.title}**`);
        lines.push(`   Modified: ${modifiedDate}`);
        lines.push(`   ID: ${note.identifier}`);
        lines.push('');
      });

      lines.push('You can also use bear-list-tags to see available tags.');

      if (hasMore) {
        lines.push(`Use bear-find-untagged-notes with limit: ${totalCount} to get all results.`);
      }

      return createToolResponse(lines.join('\n'));
    } catch (error) {
      logger.error('bear-find-untagged-notes failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-add-tag',
  {
    title: 'Add Tags to Note',
    description:
      'Add one or more tags to an existing Bear note. Tags are appended at the end of the note body to preserve frontmatter and title. Use bear-list-tags to see available tags.',
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes or bear-find-untagged-notes'),
      tags: z
        .array(z.string().trim().min(1, 'Tag name cannot be empty'))
        .min(1, 'At least one tag is required')
        .describe('Tag names without # symbol (e.g., ["career", "career/meetings"])'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ id, tags }): Promise<CallToolResult> => {
    logger.info(`bear-add-tag called with id: ${id}, tags: [${tags.join(', ')}]`);

    try {
      const existingNote = getNoteContent(id);
      if (!existingNote) {
        return createToolResponse(
          `Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.\n\nUse bear-search-notes to find the correct note identifier.`
        );
      }

      if (!existingNote.text) {
        return createToolResponse(
          `Note "${existingNote.title}" has no body text. Use bear-add-text to add content first.`
        );
      }

      const preWriteTags = getNoteTags(id);
      const newTagsLower = tags.map((t) => t.toLowerCase());

      // Skip the write entirely if all requested tags already exist
      const alreadyPresent = newTagsLower.every((t) => preWriteTags.includes(t));
      if (alreadyPresent) {
        const tagList = tags.map((t) => `#${t}`).join(', ');
        return createToolResponse(
          `Tags already present on note "${existingNote.title}".\n\nTags: ${tagList}\nNote ID: ${id}`
        );
      }

      const preWriteText = existingNote.text;

      // Combine existing and new tags, then append at end of body.
      // Bear's native add-tag prepends #tag above everything, corrupting YAML notes.
      const allTags = [...new Set([...preWriteTags, ...newTagsLower])];
      const bodyWithNewTags = appendTagsToBody(existingNote.text, allTags);

      const url = buildBearUrl('add-text', {
        id,
        text: bodyWithNewTags,
        mode: 'replace_all',
        open_note: 'no',
        show_window: 'no',
        new_window: 'no',
      });

      await executeBearXCallbackApi(url);

      const verification = await verifyNoteAfterWrite(id, preWriteText, allTags);

      const tagList = tags.map((t) => `#${t}`).join(', ');

      if (!verification.success) {
        const failureDetails = verification.failures.map((f) => `- ${f.message}`).join('\n');
        return createToolResponse(
          `Tag add verification FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${id}`
        );
      }

      return createToolResponse(
        `Tags added (verified).\n\nNote: "${existingNote.title}"\nTags: ${tagList}\nNote ID: ${id}`
      );
    } catch (error) {
      logger.error('bear-add-tag failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-archive-note',
  {
    title: 'Archive Bear Note',
    description:
      "Move a note to Bear's archive. The note will no longer appear in regular searches but can be found in Bear's Archive section. Use bear-search-notes first to get the note ID.",
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes or bear-open-note'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id }): Promise<CallToolResult> => {
    logger.info(`bear-archive-note called with id: ${id}`);

    try {
      const existingNote = getNoteContent(id);
      if (!existingNote) {
        return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
      }

      const url = buildBearUrl('archive', {
        id,
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      // Verify the note is actually archived via SQLite
      const deadline = Date.now() + 2_000;

      while (Date.now() < deadline) {
        if (isNoteArchived(id) === true) {
          return createToolResponse(
            `Note archived (verified).\n\nNote: "${existingNote.title}"\nID: ${id}`
          );
        }
        await wait(25);
      }

      return createToolResponse(
        `Archive command sent but verification failed — note "${existingNote.title}" may not be archived.\n\nID: ${id}\nCheck Bear manually.`
      );
    } catch (error) {
      logger.error('bear-archive-note failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-rename-tag',
  {
    title: 'Rename Tag',
    description:
      'Rename a tag across all notes in your Bear library. Useful for reorganizing tag taxonomy, fixing typos, or restructuring tag hierarchies. Use bear-list-tags first to see existing tags.',
    inputSchema: {
      name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'Tag name is required'))
        .describe('Current tag name to rename (without # symbol)'),
      new_name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'New tag name is required'))
        .describe(
          'New tag name (without # symbol). Use slashes for hierarchy, e.g., "archive/old-project"'
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name, new_name }): Promise<CallToolResult> => {
    logger.info(`bear-rename-tag called with name: "${name}", new_name: "${new_name}"`);

    try {
      const url = buildBearUrl('rename-tag', {
        name,
        new_name,
        open_note: 'no',
        new_window: 'no',
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      // Verify: old tag gone AND new tag present
      const deadline = Date.now() + 2_000;

      while (Date.now() < deadline) {
        if (!tagExists(name) && tagExists(new_name)) {
          return createToolResponse(`Tag renamed (verified).\n\nFrom: #${name}\nTo: #${new_name}`);
        }
        await wait(25);
      }

      return createToolResponse(
        `Rename command sent but verification failed — could not confirm #${name} was renamed to #${new_name}.\n\nCheck Bear manually.`
      );
    } catch (error) {
      logger.error('bear-rename-tag failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-delete-tag',
  {
    title: 'Delete Tag',
    description:
      'Delete a tag from all notes in your Bear library. Removes the tag but preserves the notes themselves. Use bear-list-tags first to see existing tags.',
    inputSchema: {
      name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'Tag name is required'))
        .describe('Tag name to delete (without # symbol)'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name }): Promise<CallToolResult> => {
    logger.info(`bear-delete-tag called with name: "${name}"`);

    try {
      const url = buildBearUrl('delete-tag', {
        name,
        open_note: 'no',
        new_window: 'no',
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      // Verify: tag no longer exists
      const deadline = Date.now() + 2_000;

      while (Date.now() < deadline) {
        if (!tagExists(name)) {
          return createToolResponse(`Tag deleted (verified).\n\nTag: #${name}`);
        }
        await wait(25);
      }

      return createToolResponse(
        `Delete command sent but verification failed — #${name} may still exist.\n\nCheck Bear manually.`
      );
    } catch (error) {
      logger.error('bear-delete-tag failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-upsert-note',
  {
    title: 'Create or Replace Note',
    description:
      'Create a new Bear note or replace an existing one entirely. If a note with the given ID exists (or a unique title match is found), replaces it with the provided content while preserving tags. If no match, creates a new note. Returns the note as it actually exists after the operation — not just "success".',
    inputSchema: {
      id: z
        .string()
        .trim()
        .optional()
        .describe('Note identifier — preferred when available. Use bear-search-notes to find it.'),
      title: z
        .string()
        .trim()
        .optional()
        .describe(
          'Note title for matching (used when ID is not available). If multiple notes share this title, the operation is refused with a list of matches.'
        ),
      text: z
        .string()
        .trim()
        .min(1, 'Note content is required')
        .describe('Full note content in markdown format, including H1 title and any frontmatter.'),
      tags: z
        .string()
        .trim()
        .optional()
        .describe(
          'Tags separated by commas, e.g., "chorus/questions,chorus". Applied on create; preserved automatically on replace.'
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id, title, text, tags }): Promise<CallToolResult> => {
    logger.info(
      `bear-upsert-note called with id: ${id || 'none'}, title: ${title ? '"' + title + '"' : 'none'}, text length: ${text.length}`
    );

    if (!id && !title) {
      return createToolResponse(
        'Either id or title is required. Use bear-search-notes to find the note, or provide a title for matching.'
      );
    }

    try {
      // Try to find existing note by ID first, then by title
      let existingNote = id ? getNoteContent(id) : null;
      let resolvedId = id;

      if (!existingNote && title) {
        // High limit to avoid missing exact matches when many notes contain the search term
        const { notes } = searchNotes(title, undefined, 10_000);
        // Exact title matches only
        const exactMatches = notes.filter((n) => n.title.toLowerCase() === title.toLowerCase());

        if (exactMatches.length === 1) {
          existingNote = getNoteContent(exactMatches[0].identifier);
          resolvedId = exactMatches[0].identifier;
        } else if (exactMatches.length > 1) {
          const matchList = exactMatches
            .map((n) => `- "${n.title}" (ID: ${n.identifier})`)
            .join('\n');
          return createToolResponse(
            `Multiple notes match title "${title}". Specify by ID:\n\n${matchList}`
          );
        }
      }

      if (existingNote && resolvedId) {
        // Chorus conventions: validate structure before replacing
        if (ENABLE_CHORUS_CONVENTIONS) {
          const validation = validateChorusStructure(text);
          if (!validation.valid) {
            const details = validation.violations.map((v) => `- ${v.message}`).join('\n');
            return createToolResponse(
              `Chorus conventions validation failed.\n\n${details}\n\nFix the above issues and retry.`
            );
          }
        }

        // Replace existing note
        const preWriteText = existingNote.text ?? '';
        const preWriteTags = getNoteTags(resolvedId);

        const bodyWithTags = appendTagsToBody(text, preWriteTags);

        // Skip the write if content is already identical (idempotent no-op)
        if (bodyWithTags === preWriteText) {
          return createToolResponse(
            `Note already matches the provided content.\n\nNote ID: ${resolvedId}\nTitle: "${existingNote.title}"`
          );
        }

        const url = buildBearUrl('add-text', {
          id: resolvedId,
          text: bodyWithTags,
          mode: 'replace_all',
        });

        await executeBearXCallbackApi(url);

        const verification = await verifyNoteAfterWrite(resolvedId, preWriteText, preWriteTags);

        if (!verification.success) {
          const failureDetails = verification.failures.map((f) => `- ${f.message}`).join('\n');
          return createToolResponse(
            `Upsert verification FAILED for note "${existingNote.title}".\n\n${failureDetails}\n\nNote ID: ${resolvedId}\nUse bear-open-note to inspect the current state.`
          );
        }

        // Return the actual note content post-write
        const updatedNote = getNoteContent(resolvedId);
        const noteBody = updatedNote?.text ?? '*Could not read note back*';

        return createToolResponse(
          `Note replaced and verified.\n\nNote ID: ${resolvedId}\nTitle: "${updatedNote?.title}"\n\n---\n\n${noteBody}`
        );
      } else {
        // Create new note — pass title explicitly so Bear's ZTITLE matches our poll.
        // Strip leading H1 from body when title is provided to prevent Bear doubling
        // it (Bear adds title as H1 AND keeps it in the body text).
        const h1Match = text.match(/^#\s+(.+?)\s*$/m);
        const noteTitle = title || h1Match?.[1];
        const bodyForCreate = noteTitle ? stripLeadingHeader(text, noteTitle) : text;

        const { text: createText, tags: createTags } = ENABLE_CHORUS_CONVENTIONS
          ? applyChorusConventions({ text: bodyForCreate, tags, title: noteTitle })
          : { text: bodyForCreate, tags };

        const url = buildBearUrl('create', {
          title: ENABLE_CHORUS_CONVENTIONS ? undefined : noteTitle,
          text: createText,
          tags: createTags,
        });
        await executeBearXCallbackApi(url);

        const createdId = noteTitle ? await awaitNoteCreation(noteTitle) : undefined;

        if (createdId) {
          const createdNote = getNoteContent(createdId);
          const noteBody = createdNote?.text ?? '*Could not read note back*';
          return createToolResponse(
            `Note created and verified.\n\nNote ID: ${createdId}\nTitle: "${createdNote?.title}"\n\n---\n\n${noteBody}`
          );
        }

        return createToolResponse(
          'Note created (unverified — could not recover note ID). Use bear-search-notes to confirm.'
        );
      }
    } catch (error) {
      logger.error('bear-upsert-note failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-trash-note',
  {
    title: 'Trash Bear Note',
    description:
      "Move a note to Bear's trash. Unlike archive, trashed notes are eventually deleted. Verifies the note was actually trashed via database check. Use bear-search-notes first to get the note ID.",
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes or bear-open-note'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id }): Promise<CallToolResult> => {
    logger.info(`bear-trash-note called with id: ${id}`);

    try {
      const existingNote = getNoteContent(id);
      if (!existingNote) {
        return createToolResponse(
          `Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.\n\nUse bear-search-notes to find the correct note identifier.`
        );
      }

      const url = buildBearUrl('trash', {
        id,
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      // Verify the note is actually trashed via SQLite
      const deadline = Date.now() + 2_000;

      while (Date.now() < deadline) {
        const raw = getNoteRaw(id);
        if (raw?.trashed) {
          return createToolResponse(
            `Note trashed and verified.\n\nNote: "${existingNote.title}"\nID: ${id}`
          );
        }
        await wait(25);
      }

      return createToolResponse(
        `Trash command sent but verification failed — note "${existingNote.title}" may not be trashed.\n\nID: ${id}\nCheck Bear manually.`
      );
    } catch (error) {
      logger.error('bear-trash-note failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-get-tags',
  {
    title: 'Get Note Tags',
    description:
      'Get the tags assigned to a Bear note without reading the full content. Returns a lightweight tag list for quick triage and filtering.',
    inputSchema: {
      id: z
        .string()
        .trim()
        .min(1, 'Note ID is required')
        .describe('Note identifier (ID) from bear-search-notes'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }): Promise<CallToolResult> => {
    logger.info(`bear-get-tags called with id: ${id}`);

    try {
      const existingNote = getNoteContent(id);
      if (!existingNote) {
        return createToolResponse(
          `Note with ID '${id}' not found.\n\nUse bear-search-notes to find the correct identifier.`
        );
      }

      const tags = getNoteTags(id);
      const tagList = tags.length > 0 ? tags.map((t) => `#${t}`).join(', ') : '(no tags)';

      return createToolResponse(`Note: "${existingNote.title}"\nID: ${id}\nTags: ${tagList}`);
    } catch (error) {
      logger.error('bear-get-tags failed:', error);
      throw error;
    }
  }
);

async function main(): Promise<void> {
  logger.info(`Bear Notes MCP Server initializing... Version: ${APP_VERSION}`);

  // Handle process errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Bear Notes MCP Server connected and ready');
}

main().catch((error) => {
  logger.error('Server startup failed:', error);
  process.exit(1);
});
