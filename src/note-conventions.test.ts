import { describe, expect, it } from 'vitest';

import { applyChorusConventions, validateChorusStructure } from './note-conventions.js';

const validNote = [
  '---',
  'type: question',
  'summary: What is gravity?',
  'tags: [chorus/questions, chorus]',
  '---',
  '# What is gravity?',
  '',
  'Body content here.',
  '',
  '#chorus/questions #chorus',
].join('\n');

describe('validateChorusStructure', () => {
  it('accepts a valid Chorus note (all 4 rules pass)', () => {
    const result = validateChorusStructure(validNote);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects note without YAML frontmatter', () => {
    const note = '# Title\n\nSome body text.\n\n#chorus';
    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'missing_yaml' })
    );
  });

  it('rejects note with wrong YAML field order (summary before type)', () => {
    const note = [
      '---',
      'summary: What is gravity?',
      'type: question',
      'tags: [chorus]',
      '---',
      '# What is gravity?',
      '',
      '#chorus',
    ].join('\n');

    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'yaml_field_order' })
    );
  });

  it('rejects note without H1 after YAML', () => {
    const note = [
      '---',
      'type: question',
      'summary: What is gravity?',
      'tags: [chorus]',
      '---',
      'Just a paragraph, no heading.',
      '',
      '#chorus',
    ].join('\n');

    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'missing_h1' })
    );
  });

  it('rejects note where YAML tags do not mirror inline tags', () => {
    const note = [
      '---',
      'type: question',
      'summary: What is gravity?',
      'tags: [chorus/questions, chorus]',
      '---',
      '# What is gravity?',
      '',
      'Body content here.',
      '',
      '#chorus',
    ].join('\n');

    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'tags_not_mirrored' })
    );
  });

  it('accepts multi-word tags with closing hash (#my tag#)', () => {
    const note = [
      '---',
      'type: question',
      'summary: What is gravity?',
      'tags: [my tag, chorus]',
      '---',
      '# What is gravity?',
      '',
      'Body content here.',
      '',
      '#my tag# #chorus',
    ].join('\n');

    const result = validateChorusStructure(note);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('collects multiple violations at once', () => {
    const note = 'Just plain text, nothing structured.';
    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    // At minimum, missing_yaml — other rules only fire when YAML is present
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'missing_yaml' })
    );
  });

  it('collects field order + missing H1 + tag mismatch together', () => {
    const note = [
      '---',
      'summary: What is gravity?',
      'type: question',
      'tags: [chorus/questions, chorus]',
      '---',
      'No heading here.',
      '',
      '#chorus',
    ].join('\n');

    const result = validateChorusStructure(note);

    expect(result.valid).toBe(false);
    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain('yaml_field_order');
    expect(rules).toContain('missing_h1');
    expect(rules).toContain('tags_not_mirrored');
  });
});

describe('applyChorusConventions', () => {
  it('builds a full Chorus note from minimal input', () => {
    const result = applyChorusConventions({
      text: 'Body content.',
      tags: 'chorus/questions,chorus',
      title: 'My Question',
    });

    expect(result.text).toContain('---');
    expect(result.text).toContain('type:');
    expect(result.text).toContain('summary:');
    expect(result.text).toContain('tags: [chorus/questions, chorus]');
    expect(result.text).toContain('# My Question');
    expect(result.text).toContain('Body content.');
    expect(result.text).toContain('#chorus/questions #chorus');
  });

  it('preserves existing YAML fields while normalizing', () => {
    const input = [
      '---',
      'type: reference',
      'summary: A reference note',
      'tags: [chorus/craft]',
      '---',
      '# Craft Notes',
      '',
      'Some content here.',
    ].join('\n');

    const result = applyChorusConventions({
      text: input,
      tags: undefined,
      title: 'Craft Notes',
    });

    expect(result.text).toContain('type: reference');
    expect(result.text).toContain('summary: A reference note');
    expect(result.text).toContain('tags: [chorus/craft]');
    expect(result.text).toContain('# Craft Notes');
    expect(result.text).toContain('#chorus/craft');
  });

  it('merges new tags with existing YAML tags', () => {
    const input = [
      '---',
      'type: question',
      'summary: A question',
      'tags: [chorus]',
      '---',
      '# A Question',
      '',
      'Body text.',
    ].join('\n');

    const result = applyChorusConventions({
      text: input,
      tags: 'chorus/questions',
      title: 'A Question',
    });

    expect(result.text).toContain('tags: [chorus, chorus/questions]');
    expect(result.text).toContain('#chorus');
    expect(result.text).toContain('#chorus/questions');
  });

  it('synthesizes H1 from title when body has none', () => {
    const result = applyChorusConventions({
      text: 'Just body text.',
      tags: undefined,
      title: 'Generated Title',
    });

    expect(result.text).toContain('# Generated Title');
  });

  it('returns undefined tags', () => {
    const result = applyChorusConventions({
      text: 'Some text.',
      tags: 'chorus',
      title: 'Test',
    });

    expect(result.tags).toBeUndefined();
    expect(result.text).toContain('#chorus');
  });
});
