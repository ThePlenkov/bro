import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createRegistry } from './template.ts';
import { validate, type Diagnostic } from './validate.ts';

const root = mkdtempSync(join(tmpdir(), 'brose-val-'));
const tdir = join(root, 'templates');
const ddir = join(root, 'docs');
mkdirSync(tdir, { recursive: true });
mkdirSync(ddir, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

writeFileSync(
  join(tdir, 'note.md'),
  `---
name: note
version: 1
fields:
  title: { required: true, type: string }
  status: { type: string, enum: [draft, active] }
---
# {{title}}

## Context

## Decisions
`
);
writeFileSync(
  join(tdir, 'note-v2.md'),
  `---
name: note
version: 2
fields:
  title: { required: true, type: string }
---
# {{title}}

## Context

## Decisions

## Follow-ups
`
);

const registry = createRegistry({ dirs: [tdir] });

const doc = (name: string, text: string): string => {
  const p = join(ddir, name);
  writeFileSync(p, text);
  return p;
};

const rules = (d: Diagnostic[]): string[] => d.map(x => x.rule);
/** error-severity diagnostics — warn advisories (template-outdated)
 *  never gate. */
const errors = (d: Diagnostic[]): Diagnostic[] => d.filter(x => x.severity === 'error');

const VALID = `---
template: note@1
title: n
status: draft
---
# n

## Context

## Decisions
`;

describe('validate — binding', () => {
  it('passes a conforming doc', () => {
    // note@1 pinned while note@2 exists → only the advisory warn.
    assert.deepEqual(errors(validate(doc('ok.md', VALID), { registry })), []);
  });

  it('errors when the doc has no template and no flag supplies one', () => {
    const d = validate(doc('bare.md', '---\ntitle: x\n---\n# x\n'), { registry });
    assert.deepEqual(rules(d), ['template-missing']);
    assert.equal(d[0]!.severity, 'error');
  });

  it('errors on a template ref the registry lacks', () => {
    const d = validate(doc('ghost.md', '---\ntemplate: ghost@1\n---\n# x\n'), { registry });
    assert.deepEqual(rules(d), ['template-unknown']);
  });

  it('--template overrides/supplies the binding', () => {
    const d = validate(doc('flagged.md', VALID.replace('note@1', 'whatever@9')), {
      template: 'note@1',
      registry,
    });
    assert.deepEqual(errors(d), []);
  });
});

describe('validate — fields', () => {
  it('reports a missing required field', () => {
    const d = validate(doc('nofield.md', VALID.replace('title: n\n', '')), { registry });
    assert.ok(rules(d).includes('field-required'));
    assert.equal(d[0]!.line, 1);
  });

  it('reports a wrong field type and a bad enum value', () => {
    const bad = VALID.replace('title: n', 'title: 3').replace('status: draft', 'status: done');
    const d = validate(doc('badfield.md', bad), { registry });
    assert.ok(rules(d).includes('field-type'));
    assert.ok(rules(d).includes('field-enum'));
    assert.equal(d.find(x => x.rule === 'field-enum')!.line, 3);
  });
});

describe('validate — sections', () => {
  it('reports a missing required section', () => {
    const d = validate(doc('nosec.md', VALID.replace('## Decisions\n', '')), { registry });
    assert.deepEqual(
      rules(d).filter(r => r.startsWith('section')),
      ['section-missing']
    );
  });

  it('reports out-of-order sections', () => {
    const swapped = VALID.replace('## Context\n\n## Decisions', '## Decisions\n\n## Context');
    const d = validate(doc('swapped.md', swapped), { registry });
    assert.ok(rules(d).includes('section-order'));
  });

  it('matches {{placeholder}} template headings to any doc title', () => {
    const d = validate(doc('renamed.md', VALID.replace('# n', '# Something Else')), {
      registry,
    });
    assert.deepEqual(errors(d), []);
  });

  it('does not count headings inside fenced code', () => {
    const fenced = VALID + '\n```md\n## Decisions\n```\n';
    const d = validate(doc('fenced.md', fenced), { registry });
    assert.deepEqual(errors(d), []);
  });
});

describe('validate — template drift', () => {
  it('warns template-outdated against the pinned version only', () => {
    const d = validate(doc('pinned.md', VALID), { registry });
    // note@1 pinned, note@2 in registry — @1 still passes (Follow-ups
    // is not required of @1 docs) plus the advisory.
    assert.deepEqual(rules(d), ['template-outdated']);
    assert.equal(d[0]!.severity, 'warn');
  });

  it('validates a latest-version doc against the new skeleton', () => {
    const v2 = VALID.replace('note@1', 'note@2') + '\n## Follow-ups\n';
    const d = validate(doc('v2.md', v2), { registry });
    assert.deepEqual(d, []);
  });
});
