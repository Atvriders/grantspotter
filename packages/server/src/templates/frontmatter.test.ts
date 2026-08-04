import { describe, expect, it } from 'vitest';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';

const DOC = `---
id: funder-ardc
title: ARDC Grants Program
layer: funder
order: 10
alwaysAvailable: false
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 900-1400 words
programIds: [ardc-grants]
sources:
  - label: ARDC grant application instructions
    url: https://www.ardc.net/apply/grant-application-instructions/
  - label: ARDC apply page
    url: https://www.ardc.net/apply/
---

# Body starts here

Indirect costs are capped at 20 percent.
`;

describe('parseFrontmatter', () => {
  it('parses scalars, numbers, booleans, flow arrays and arrays of maps', () => {
    const { data } = parseFrontmatter(DOC);
    expect(data.id).toBe('funder-ardc');
    expect(data.title).toBe('ARDC Grants Program');
    expect(data.order).toBe(10);
    expect(data.alwaysAvailable).toBe(false);
    expect(data.appliesTo).toEqual(['ham_grant', 'adjacent_stem']);
    expect(data.lengthTarget).toBe('900-1400 words');
    expect(data.programIds).toEqual(['ardc-grants']);
    expect(data.sources).toEqual([
      {
        label: 'ARDC grant application instructions',
        url: 'https://www.ardc.net/apply/grant-application-instructions/',
      },
      { label: 'ARDC apply page', url: 'https://www.ardc.net/apply/' },
    ]);
  });

  it('keeps the body verbatim and strips exactly one leading newline', () => {
    const { body } = parseFrontmatter(DOC);
    expect(body.startsWith('\n# Body starts here')).toBe(true);
    expect(body).toContain('Indirect costs are capped at 20 percent.');
  });

  it('does not split a value on a colon inside a URL', () => {
    const { data } = parseFrontmatter('---\nurl: https://example.org/a:b\n---\nbody\n');
    expect(data.url).toBe('https://example.org/a:b');
  });

  it('throws when the document does not open with a frontmatter block', () => {
    expect(() => parseFrontmatter('# no frontmatter\n')).toThrow(FrontmatterError);
  });

  it('throws when the frontmatter block is unterminated', () => {
    expect(() => parseFrontmatter('---\nid: x\n')).toThrow(/unterminated/);
  });

  it('throws when a list mixes scalars and maps', () => {
    const bad = '---\nsources:\n  - plain\n  - label: x\n---\nbody\n';
    expect(() => parseFrontmatter(bad)).toThrow(/mixes scalars and maps/);
  });

  // ---------------------------------------------------------------------------
  // The rest of this file pins the rule the whole task exists for: a malformed
  // template FAILS, it does not quietly parse into something plausible. Each case
  // below is one this parser would otherwise have accepted and turned into a value
  // no author wrote.
  // ---------------------------------------------------------------------------

  it('closes the block only on a line that is exactly "---"', () => {
    // `indexOf('\n---')` alone also matches `----` or `---8<---`, which would end the
    // block early and silently move real frontmatter into the body.
    const doc = '---\nid: x\ntitle: --- not a delimiter ---\n---\nbody\n';
    const { data, body } = parseFrontmatter(doc);
    expect(data.title).toBe('--- not a delimiter ---');
    expect(body).toBe('body\n');
  });

  it('throws on a duplicate key instead of letting the last one win', () => {
    expect(() => parseFrontmatter('---\nid: a\nid: b\n---\nbody\n')).toThrow(/duplicate/);
  });

  it('throws on a key with neither an inline value nor an indented block', () => {
    // Bare `appliesTo:` would otherwise parse as `[]`, which `selectTemplates` reads
    // as "applies to every class" — the opposite of an author forgetting a value.
    expect(() => parseFrontmatter('---\nappliesTo:\ntitle: x\n---\nbody\n')).toThrow(/no value/);
    expect(() => parseFrontmatter('---\nappliesTo:\n---\nbody\n')).toThrow(/no value/);
  });

  it('throws on an empty element in a flow array rather than yielding an empty id', () => {
    expect(() => parseFrontmatter('---\nprogramIds: [ardc-grants, ]\n---\nbody\n')).toThrow(
      /empty element/,
    );
  });

  it('accepts an empty flow array, which is a real and different statement', () => {
    const { data } = parseFrontmatter('---\nprogramIds: []\n---\nbody\n');
    expect(data.programIds).toEqual([]);
  });

  it('throws on an unindented continuation line inside a block list', () => {
    expect(() => parseFrontmatter('---\nsources:\n- label: x\n---\nbody\n')).toThrow(
      FrontmatterError,
    );
  });

  it('throws when an indented line appears where a key was expected', () => {
    expect(() => parseFrontmatter('---\n  id: x\n---\nbody\n')).toThrow(/indentation/);
  });

  it('throws on a line with no colon at all', () => {
    expect(() => parseFrontmatter('---\nid\n---\nbody\n')).toThrow(/missing ":"/);
  });

  it('throws on a key the key grammar does not allow', () => {
    expect(() => parseFrontmatter('---\n9lives: x\n---\nbody\n')).toThrow(/invalid frontmatter key/);
  });

  it('normalises CRLF and strips a leading BOM, so a Windows edit still loads', () => {
    const { data, body } = parseFrontmatter('﻿---\r\nid: x\r\n---\r\n\r\nbody\r\n');
    expect(data.id).toBe('x');
    expect(body).toBe('\nbody\n');
  });

  it('reads quoted scalars, negative numbers and decimals', () => {
    const { data } = parseFrontmatter(
      '---\na: "10"\nb: \'true\'\nc: -3\nd: 1.5\ne: 010\n---\nbody\n',
    );
    expect(data.a).toBe('10');
    expect(data.b).toBe('true');
    expect(data.c).toBe(-3);
    expect(data.d).toBe(1.5);
    expect(data.e).toBe(10);
  });

  it('tolerates blank lines and # comments between keys', () => {
    const { data } = parseFrontmatter('---\nid: x\n\n# a comment\ntitle: y\n---\nbody\n');
    expect(data).toEqual({ id: 'x', title: 'y' });
  });

  it('parses a block list of scalars', () => {
    const { data } = parseFrontmatter('---\nrequires:\n  - a\n  - b\n---\nbody\n');
    expect(data.requires).toEqual(['a', 'b']);
  });

  it('names the offending key when a list mixes maps and scalars in the other order', () => {
    expect(() => parseFrontmatter('---\nsources:\n  - label: x\n  - plain\n---\nbody\n')).toThrow(
      /list "sources" mixes scalars and maps/,
    );
  });

  it('carries a body containing its own "---" horizontal rules', () => {
    const { body } = parseFrontmatter('---\nid: x\n---\n\nintro\n\n---\n\noutro\n');
    expect(body).toBe('\nintro\n\n---\n\noutro\n');
  });

  it('is a FrontmatterError every time, so a caller can tell parse from I/O failure', () => {
    for (const bad of ['no frontmatter', '---\nunterminated: yes\n', '---\nid: a\nid: b\n---\n']) {
      expect(() => parseFrontmatter(bad)).toThrow(FrontmatterError);
    }
  });
});
