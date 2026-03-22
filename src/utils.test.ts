import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendTagsToBody,
  convertCoreDataTimestamp,
  noteHasHeader,
  parseDateString,
  spliceSection,
  stripLeadingHeader,
  stripTrailingTags,
} from './utils.js';

describe('parseDateString', () => {
  beforeEach(() => {
    // Fix "now" to January 15, 2026 for predictable tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"start of last month" in January returns December of previous year', () => {
    const result = parseDateString('start of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December (0-indexed)
    expect(result.getDate()).toBe(1);
  });

  it('"end of last month" returns last day with end-of-day time', () => {
    const result = parseDateString('end of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
    expect(result.getSeconds()).toBe(59);
  });
});

describe('noteHasHeader', () => {
  const noteText = [
    '# Title',
    'Intro paragraph',
    '',
    '## Details',
    'Some details here',
    '',
    '### Q&A',
    'Questions and answers',
    '',
    '## Details (v2)',
    'Updated details',
    '',
    '## v1.0 Release',
    'Release notes',
  ].join('\n');

  it('finds an exact header match', () => {
    expect(noteHasHeader(noteText, 'Details')).toBe(true);
  });

  it('strips markdown prefix from header input', () => {
    expect(noteHasHeader(noteText, '## Details')).toBe(true);
    expect(noteHasHeader(noteText, '### Q&A')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(noteHasHeader(noteText, 'details')).toBe(true);
    expect(noteHasHeader(noteText, 'DETAILS')).toBe(true);
  });

  it('rejects partial header name', () => {
    expect(noteHasHeader(noteText, 'Detail')).toBe(false);
  });

  it('handles parentheses in header name', () => {
    expect(noteHasHeader(noteText, 'Details (v2)')).toBe(true);
  });

  it('handles ampersand in header name', () => {
    expect(noteHasHeader(noteText, 'Q&A')).toBe(true);
  });

  it('handles dots in header name', () => {
    expect(noteHasHeader(noteText, 'v1.0 Release')).toBe(true);
  });

  it('returns false for empty note text', () => {
    expect(noteHasHeader('', 'Details')).toBe(false);
  });

  it('returns false for empty header input', () => {
    expect(noteHasHeader(noteText, '')).toBe(false);
  });
});

describe('stripLeadingHeader', () => {
  it('strips matching header with exact case', () => {
    expect(stripLeadingHeader('## Details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header case-insensitively', () => {
    expect(stripLeadingHeader('## DETAILS\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('## details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header at any heading level', () => {
    expect(stripLeadingHeader('### Details\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('#### Details\nNew content', 'Details')).toBe('New content');
  });

  it('does not strip when header text does not match', () => {
    expect(stripLeadingHeader('## Other\nNew content', 'Details')).toBe('## Other\nNew content');
  });

  it('does not strip when text does not start with a header', () => {
    expect(stripLeadingHeader('New content', 'Details')).toBe('New content');
  });

  it('handles special characters in header name', () => {
    expect(stripLeadingHeader('## Details (v2)\nNew content', 'Details (v2)')).toBe('New content');
    expect(stripLeadingHeader('## Q&A\nNew content', 'Q&A')).toBe('New content');
  });

  it('returns text unchanged when header is empty string', () => {
    expect(stripLeadingHeader('## Details\nNew content', '')).toBe('## Details\nNew content');
  });
});

describe('convertCoreDataTimestamp', () => {
  it('converts Core Data timestamp to correct ISO string', () => {
    // Core Data timestamp 0 = 2001-01-01 00:00:00 UTC
    const result = convertCoreDataTimestamp(0);

    expect(result).toBe('2001-01-01T00:00:00.000Z');
  });
});

describe('spliceSection', () => {
  const chorusNote = [
    '---',
    'type: question',
    'summary: Test question',
    'tags: [chorus/questions]',
    '---',
    '# What is gravity?',
    'Gravity is a fundamental force.',
    '',
    '## Details',
    'More details here.',
    'And another line.',
    '',
    '## References',
    'Some references.',
  ].join('\n');

  it('replaces H1 section content (the doubling bug fix)', () => {
    const result = spliceSection(chorusNote, 'What is gravity?', 'Gravity pulls things down.');

    expect(result).toContain('# What is gravity?');
    expect(result).toContain('Gravity pulls things down.');
    expect(result).not.toContain('Gravity is a fundamental force.');
    // Sibling sections preserved
    expect(result).toContain('## Details');
    expect(result).toContain('## References');
  });

  it('replaces a mid-level section without touching siblings', () => {
    const result = spliceSection(chorusNote, 'Details', 'Updated details.');

    expect(result).toContain('## Details');
    expect(result).toContain('Updated details.');
    expect(result).not.toContain('More details here.');
    // H1 and other sections preserved
    expect(result).toContain('# What is gravity?');
    expect(result).toContain('## References');
  });

  it('replaces the last section (no following header)', () => {
    const result = spliceSection(chorusNote, 'References', 'New references.');

    expect(result).toContain('## References');
    expect(result).toContain('New references.');
    expect(result).not.toContain('Some references.');
  });

  it('preserves YAML frontmatter when splicing H1', () => {
    const result = spliceSection(chorusNote, 'What is gravity?', 'New content.');

    expect(result).toContain('---\ntype: question');
    expect(result).toContain('tags: [chorus/questions]\n---');
  });

  it('inserts blank line between header and replacement content', () => {
    const result = spliceSection(chorusNote, 'Details', 'Updated details.');

    expect(result).toContain('## Details\n\nUpdated details.');
  });

  it('returns body unchanged when header not found', () => {
    const result = spliceSection(chorusNote, 'Nonexistent', 'New content.');

    expect(result).toBe(chorusNote);
  });

  it('matches headers case-insensitively', () => {
    const result = spliceSection(chorusNote, 'DETAILS', 'Updated.');

    expect(result).toContain('Updated.');
    expect(result).not.toContain('More details here.');
  });

  it('preserves sub-sections when replacing parent header', () => {
    const noteWithSubs = [
      '## Execution Model',
      'Original body text.',
      '',
      '### Progress tracking',
      'Tracking content.',
      '',
      '### Services',
      'Service details.',
      '',
      '## Other Section',
      'Other content.',
    ].join('\n');

    const result = spliceSection(noteWithSubs, 'Execution Model', 'New body text.');

    expect(result).toContain('## Execution Model');
    expect(result).toContain('New body text.');
    expect(result).not.toContain('Original body text.');
    // Sub-sections preserved
    expect(result).toContain('### Progress tracking');
    expect(result).toContain('Tracking content.');
    expect(result).toContain('### Services');
    expect(result).toContain('## Other Section');
  });
});

describe('stripTrailingTags', () => {
  it('strips trailing tag lines', () => {
    const body = 'Content here.\n\n#chorus #chorus/craft';
    expect(stripTrailingTags(body)).toBe('Content here.');
  });

  it('strips trailing tags with blank lines after', () => {
    const body = 'Content here.\n\n#chorus #chorus/craft\n\n';
    expect(stripTrailingTags(body)).toBe('Content here.');
  });

  it('preserves inline tags mid-document', () => {
    const body = 'Content #chorus here.\n\nMore content.';
    expect(stripTrailingTags(body)).toBe('Content #chorus here.\n\nMore content.');
  });

  it('returns body unchanged when no trailing tags', () => {
    const body = 'Just content.';
    expect(stripTrailingTags(body)).toBe('Just content.');
  });

  it('handles multi-word tags with closing hash', () => {
    const body = 'Content.\n\n#my tag#';
    expect(stripTrailingTags(body)).toBe('Content.');
  });
});

describe('appendTagsToBody', () => {
  it('appends tags as inline Bear syntax at end of body', () => {
    const result = appendTagsToBody('Note content here.', ['chorus/questions', 'science']);

    expect(result).toBe('Note content here.\n\n#chorus/questions #science');
  });

  it('handles multi-word tags with closing hash', () => {
    const result = appendTagsToBody('Body.', ['my tag']);

    expect(result).toBe('Body.\n\n#my tag#');
  });

  it('returns body unchanged when tags array is empty', () => {
    const result = appendTagsToBody('Body.', []);

    expect(result).toBe('Body.');
  });

  it('handles single tag', () => {
    const result = appendTagsToBody('Body.', ['chorus']);

    expect(result).toBe('Body.\n\n#chorus');
  });

  it('does not double tags when body already has them', () => {
    const body = 'Content here.\n\n#chorus #chorus/craft';
    const result = appendTagsToBody(body, ['chorus', 'chorus/craft']);

    expect(result).toBe('Content here.\n\n#chorus #chorus/craft');
  });

  it('replaces old tags with new set when different', () => {
    const body = 'Content here.\n\n#chorus #old-tag';
    const result = appendTagsToBody(body, ['chorus', 'chorus/craft']);

    expect(result).toBe('Content here.\n\n#chorus #chorus/craft');
  });
});
