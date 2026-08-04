import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FrontmatterError } from './frontmatter.js';
import {
  ALLOWED_FRONTMATTER_KEYS,
  TemplateError,
  TemplateNotFoundError,
  contentRoot,
  deriveSlots,
  getTemplate,
  loadTemplateFile,
  loadTemplates,
  selectTemplates,
  templatesRoot,
} from './load.js';

let root: string;

const COMPONENT = `---
id: need-statement
title: Need statement
layer: component
order: 10
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 200-300 words
---

{{club.name}} ({{club.callsign}}) needs {{project.equipment}}.
Again: {{club.name}}.
`;

const OVERLAY = `---
id: funder-ardc
title: ARDC overlay
layer: funder
order: 10
appliesTo: [ham_grant]
funderId: ardc
programIds: [ardc-grants]
requires: [need-statement]
sources:
  - label: ARDC apply page
    url: https://www.ardc.net/apply/
---

Indirect costs are capped at 20 percent.
`;

const PLAYBOOK = `---
id: funder-campus-sga
title: Campus SGA playbook
layer: funder
order: 90
appliesTo: []
alwaysAvailable: true
programIds: []
sources:
  - label: FSU SGA RSO funding rules
    url: https://sga.fsu.edu/accounting/funding-your-rso
---

Capital equipment is frequently barred.
`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-templates-'));
  fs.mkdirSync(path.join(root, 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'funders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components', 'need-statement.md'), COMPONENT);
  fs.writeFileSync(path.join(root, 'funders', 'funder-ardc.md'), OVERLAY);
  fs.writeFileSync(path.join(root, 'funders', 'funder-campus-sga.md'), PLAYBOOK);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * A throwaway tree holding one component, so a malformed-frontmatter case cannot
 * leak into the shared `root` and change what `loadTemplates(root)` returns for
 * every other test in this file.
 */
function withTemplate<T>(file: string, contents: string, fn: (abs: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-template-one-'));
  try {
    fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
    const abs = path.join(dir, 'components', file);
    fs.writeFileSync(abs, contents);
    return fn(abs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** COMPONENT with one frontmatter line replaced, for the shape-rejection cases. */
function componentWith(line: string, replacement: string): string {
  if (!COMPONENT.includes(`${line}\n`)) throw new Error(`fixture has no line "${line}"`);
  return COMPONENT.replace(`${line}\n`, replacement === '' ? '' : `${replacement}\n`);
}

describe('loadTemplateFile', () => {
  it('derives slots from the body, deduped and in first-appearance order', () => {
    const doc = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    expect(doc.slots).toEqual(['club.name', 'club.callsign', 'project.equipment']);
  });

  it('carries layer, order, appliesTo, lengthTarget and the raw body', () => {
    const doc = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    expect(doc.layer).toBe('component');
    expect(doc.order).toBe(10);
    expect(doc.appliesTo).toEqual(['ham_grant', 'adjacent_stem']);
    expect(doc.lengthTarget).toBe('200-300 words');
    expect(doc.body).toContain('{{club.name}}');
    expect(doc.sources).toEqual([]);
  });

  it('carries funder overlay fields', () => {
    const doc = loadTemplateFile(path.join(root, 'funders', 'funder-ardc.md'));
    expect(doc.funderId).toBe('ardc');
    expect(doc.programIds).toEqual(['ardc-grants']);
    expect(doc.requires).toEqual(['need-statement']);
    expect(doc.sources[0]?.url).toBe('https://www.ardc.net/apply/');
    expect(doc.alwaysAvailable).toBe(false);
  });

  it('rejects a file whose id does not match its filename', () => {
    const bad = path.join(root, 'components', 'mismatched.md');
    fs.writeFileSync(bad, COMPONENT);
    expect(() => loadTemplateFile(bad)).toThrow(
      /id "need-statement" does not match filename "mismatched"/,
    );
    fs.rmSync(bad);
  });
});

describe('loadTemplates and selectTemplates', () => {
  it('loads every file under components/ and funders/', () => {
    const all = loadTemplates(root);
    expect(all.map((t) => t.id).sort()).toEqual([
      'funder-ardc',
      'funder-campus-sga',
      'need-statement',
    ]);
  });

  it('getTemplate throws a named error for an unknown id', () => {
    expect(() => getTemplate('does-not-exist', root)).toThrow(/unknown template "does-not-exist"/);
  });

  it('selects the overlay for a program, the components for its class, and always-available playbooks', () => {
    const sel = selectTemplates(loadTemplates(root), {
      klass: 'ham_grant',
      programId: 'ardc-grants',
    });
    expect(sel.overlays.map((t) => t.id)).toEqual(['funder-ardc']);
    expect(sel.components.map((t) => t.id)).toEqual(['need-statement']);
    expect(sel.playbooks.map((t) => t.id)).toEqual(['funder-campus-sga']);
  });

  it('returns no overlay for an unrelated program but still returns playbooks', () => {
    const sel = selectTemplates(loadTemplates(root), {
      klass: 'ham_scholarship',
      programId: 'yaesu-dr2x-repeater',
    });
    expect(sel.overlays).toEqual([]);
    expect(sel.components).toEqual([]);
    expect(sel.playbooks.map((t) => t.id)).toEqual(['funder-campus-sga']);
  });
});

// -----------------------------------------------------------------------------
// A malformed template must FAIL, never default.
//
// Every case below is one the loader would otherwise have absorbed into a plausible
// value: `programIds` as a scalar becoming `[]` (and the overlay vanishing from the
// writing desk with no error — the exact silence the plan's "Canonical program ids"
// section warns about), `appliesTo` misspelt becoming `[]` (which selectTemplates
// reads as "applies to EVERY class", inverting the author's restriction), or a
// quoted `alwaysAvailable: "true"` becoming false and hiding the playbook.
// -----------------------------------------------------------------------------
describe('loadTemplateFile — malformed frontmatter is loud, never a default', () => {
  it('names the file when the frontmatter itself will not parse', () => {
    withTemplate('need-statement.md', '# no frontmatter here\n', (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(TemplateError);
      expect(() => loadTemplateFile(abs)).toThrow(/need-statement\.md/);
      expect(() => loadTemplateFile(abs)).toThrow(/must begin with a "---" frontmatter block/);
    });
  });

  it('keeps the underlying FrontmatterError as the cause', () => {
    withTemplate('need-statement.md', '---\nid: need-statement\n', (abs) => {
      try {
        loadTemplateFile(abs);
        expect.unreachable('a template with an unterminated frontmatter block must not load');
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateError);
        expect((err as TemplateError).cause).toBeInstanceOf(FrontmatterError);
        expect((err as TemplateError).path).toBe(abs);
      }
    });
  });

  it('rejects a frontmatter key it does not know, which is how a typo surfaces', () => {
    const typo = componentWith(
      'appliesTo: [ham_grant, adjacent_stem]',
      'appliedTo: [ham_grant, adjacent_stem]',
    );
    withTemplate('need-statement.md', typo, (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/unknown frontmatter key "appliedTo"/);
    });
  });

  it('requires appliesTo, so "every class" is always something an author wrote', () => {
    const missing = componentWith('appliesTo: [ham_grant, adjacent_stem]', '');
    withTemplate('need-statement.md', missing, (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"appliesTo" is required/);
    });
  });

  it('rejects an opportunity class that is not one of core\'s four', () => {
    const wrong = componentWith(
      'appliesTo: [ham_grant, adjacent_stem]',
      'appliesTo: [ham_grants]',
    );
    withTemplate('need-statement.md', wrong, (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"appliesTo" has an unknown class "ham_grants"/);
    });
  });

  it('accepts an explicitly empty appliesTo, which means every class on purpose', () => {
    withTemplate(
      'need-statement.md',
      componentWith('appliesTo: [ham_grant, adjacent_stem]', 'appliesTo: []'),
      (abs) => {
        expect(loadTemplateFile(abs).appliesTo).toEqual([]);
      },
    );
  });

  it('rejects a list-valued key written as a scalar instead of returning []', () => {
    withTemplate(
      'need-statement.md',
      componentWith('lengthTarget: 200-300 words', 'programIds: ardc-grants'),
      (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(/"programIds" must be a list of strings/);
      },
    );
  });

  it('rejects a list of maps where a list of strings belongs', () => {
    withTemplate(
      'need-statement.md',
      componentWith('lengthTarget: 200-300 words', 'requires:\n  - id: need-statement'),
      (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(/"requires" must be a list of strings/);
      },
    );
  });

  it('rejects a non-boolean alwaysAvailable rather than reading it as false', () => {
    withTemplate(
      'need-statement.md',
      componentWith('lengthTarget: 200-300 words', 'alwaysAvailable: "true"'),
      (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(/"alwaysAvailable" must be true or false/);
      },
    );
  });

  it('rejects a non-string lengthTarget rather than dropping it', () => {
    withTemplate('need-statement.md', componentWith('lengthTarget: 200-300 words', 'lengthTarget: 300'), (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"lengthTarget" must be a string/);
    });
  });

  it('rejects a layer that is neither component nor funder', () => {
    withTemplate('need-statement.md', componentWith('layer: component', 'layer: overlay'), (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"layer" must be "component" or "funder"/);
    });
  });

  it('rejects a non-numeric order', () => {
    withTemplate('need-statement.md', componentWith('order: 10', 'order: first'), (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"order" must be a number/);
    });
  });

  it('rejects a missing title', () => {
    withTemplate('need-statement.md', componentWith('title: Need statement', ''), (abs) => {
      expect(() => loadTemplateFile(abs)).toThrow(/"title" must be a string/);
    });
  });

  it('rejects a source entry missing its label or url', () => {
    withTemplate(
      'need-statement.md',
      componentWith('lengthTarget: 200-300 words', 'sources:\n  - url: https://example.org/a'),
      (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(/every "sources" entry needs a label and a url/);
      },
    );
  });

  it('rejects a sources list of bare strings', () => {
    withTemplate(
      'need-statement.md',
      componentWith('lengthTarget: 200-300 words', 'sources:\n  - https://example.org/a'),
      (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(/every "sources" entry needs a label and a url/);
      },
    );
  });

  it('every rejection is a TemplateError naming the file', () => {
    for (const contents of [
      componentWith('appliesTo: [ham_grant, adjacent_stem]', ''),
      componentWith('order: 10', 'order: first'),
      componentWith('layer: component', 'layer: overlay'),
      componentWith('lengthTarget: 200-300 words', 'programIds: ardc-grants'),
    ]) {
      withTemplate('need-statement.md', contents, (abs) => {
        expect(() => loadTemplateFile(abs)).toThrow(TemplateError);
        expect(() => loadTemplateFile(abs)).toThrow(/need-statement\.md/);
      });
    }
  });

  it('publishes the closed key set so a later template cannot add one by accident', () => {
    expect([...ALLOWED_FRONTMATTER_KEYS].sort()).toEqual([
      'alwaysAvailable',
      'appliesTo',
      'funderId',
      'id',
      'layer',
      'lengthTarget',
      'order',
      'programIds',
      'requires',
      'sources',
      'title',
    ]);
  });
});

describe('deriveSlots', () => {
  it('tolerates inner whitespace and normalises to the bare path', () => {
    expect(deriveSlots('{{ club.name }} and {{club.name}}')).toEqual(['club.name']);
  });

  it('reads dotted paths of any depth and ignores non-slot braces', () => {
    expect(deriveSlots('{{a}} {{a.b.c}} {{ }} {{-bad}} { {a} }')).toEqual(['a', 'a.b.c']);
  });

  it('returns an empty list for a body with no slots', () => {
    expect(deriveSlots('Plain prose, no slots at all.')).toEqual([]);
  });
});

describe('loadTemplates — whole-library invariants', () => {
  it('refuses two templates sharing an id, even across components/ and funders/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-templates-dupe-'));
    try {
      fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'funders'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'components', 'need-statement.md'), COMPONENT);
      fs.writeFileSync(
        path.join(dir, 'funders', 'need-statement.md'),
        COMPONENT.replace('layer: component', 'layer: funder'),
      );
      expect(() => loadTemplates(dir)).toThrow(/duplicate template id "need-statement"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-markdown files, so a .gitkeep does not break the load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-templates-keep-'));
    try {
      fs.mkdirSync(path.join(dir, 'components'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'funders'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'components', '.gitkeep'), '');
      fs.writeFileSync(path.join(dir, 'funders', '.gitkeep'), '');
      fs.writeFileSync(path.join(dir, 'components', 'need-statement.md'), COMPONENT);
      expect(loadTemplates(dir).map((t) => t.id)).toEqual(['need-statement']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getTemplate returns the doc for a known id', () => {
    expect(getTemplate('funder-campus-sga', root).title).toBe('Campus SGA playbook');
  });

  it('getTemplate throws TemplateNotFoundError, distinguishable from a malformed library', () => {
    expect(() => getTemplate('does-not-exist', root)).toThrow(TemplateNotFoundError);
  });
});

describe('selectTemplates — ordering and the empty-appliesTo rule', () => {
  const docs = () => loadTemplates(root);

  it('returns every component when no class is asked for', () => {
    expect(selectTemplates(docs(), {}).components.map((t) => t.id)).toEqual(['need-statement']);
  });

  it('returns no overlay when neither programId nor funderId is given', () => {
    expect(selectTemplates(docs(), { klass: 'ham_grant' }).overlays).toEqual([]);
  });

  it('matches an overlay by funderId as well as by programId', () => {
    expect(selectTemplates(docs(), { funderId: 'ardc' }).overlays.map((t) => t.id)).toEqual([
      'funder-ardc',
    ]);
  });

  it('never returns an always-available playbook as an overlay, even on a funderId hit', () => {
    const sel = selectTemplates(docs(), { funderId: 'ardc', programId: 'ardc-grants' });
    expect(sel.overlays.map((t) => t.id)).toEqual(['funder-ardc']);
    expect(sel.playbooks.map((t) => t.id)).toEqual(['funder-campus-sga']);
  });

  it('treats an empty appliesTo as every class', () => {
    const universal = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    const all = [...docs(), { ...universal, id: 'cover-letter', order: 5, appliesTo: [] }];
    expect(selectTemplates(all, { klass: 'ham_scholarship' }).components.map((t) => t.id)).toEqual([
      'cover-letter',
    ]);
  });

  it('sorts by order, then by id, so the writing desk is stable between loads', () => {
    const base = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    const all = [
      { ...base, id: 'c', order: 20 },
      { ...base, id: 'b', order: 10 },
      { ...base, id: 'a', order: 10 },
    ];
    expect(selectTemplates(all, { klass: 'ham_grant' }).components.map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('contentRoot', () => {
  it('finds the repository content/ directory by walking up from this module', () => {
    const found = contentRoot();
    expect(path.basename(found)).toBe('content');
    expect(fs.existsSync(path.join(found, 'templates', 'components'))).toBe(true);
  });

  it('templatesRoot is content/templates, and both subdirectories exist', () => {
    expect(templatesRoot()).toBe(path.join(contentRoot(), 'templates'));
    expect(fs.existsSync(path.join(templatesRoot(), 'components'))).toBe(true);
    expect(fs.existsSync(path.join(templatesRoot(), 'funders'))).toBe(true);
  });

  it('sits one level under the repo root, which is where data/reference is looked up', () => {
    // Task 12 resolves `path.join(path.dirname(contentRoot()), 'data', 'reference')`.
    expect(fs.existsSync(path.join(path.dirname(contentRoot()), 'package.json'))).toBe(true);
  });

  it('loadTemplates defaults to the shipped library and never throws on it', () => {
    // Empty today (Task 1 ships only .gitkeep); from Task 2 on this loads the real
    // library, which is where a malformed shipped template would surface.
    expect(() => loadTemplates()).not.toThrow();
  });
});
