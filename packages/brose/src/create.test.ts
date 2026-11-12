import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { create, createFile } from './create.ts';
import { parseContent } from './parse.ts';
import { createRegistry, parseTemplate } from './template.ts';
import { validate } from './validate.ts';

const root = mkdtempSync(join(tmpdir(), 'brose-new-'));
const tdir = join(root, 'templates');
after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(tdir, { recursive: true });
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
const registry = createRegistry({ dirs: [tdir] });

describe('create', () => {
  it('renders a doc: template pin + declared fields + interpolated body', () => {
    const text = create('note@1', { title: 'Hi', status: 'draft' }, { registry });
    const doc = parseContent(text);
    assert.equal(doc.frontmatter.template, 'note@1');
    assert.equal(doc.frontmatter.title, 'Hi');
    assert.equal(doc.frontmatter.status, 'draft');
    assert.ok(text.includes('# Hi'));
    assert.deepEqual(
      validate(
        (() => {
          const p = join(root, 'made.md');
          writeFileSync(p, text);
          return p;
        })(),
        { registry }
      ),
      []
    );
  });

  it('accepts a Template object directly', () => {
    const t = parseTemplate('---\nname: x\nversion: 1\n---\n# {{t}}\n');
    assert.equal(create(t, { t: 'v' }), '---\ntemplate: x@1\n---\n\n# v\n');
  });

  it('a template field literally named `template` cannot shadow the pin', () => {
    const t = parseTemplate(
      '---\nname: sneaky\nversion: 1\nfields:\n  template: { type: string }\n---\n# x\n'
    );
    const doc = parseContent(create(t, { template: 'other@9' }));
    assert.equal(doc.frontmatter.template, 'sneaky@1');
  });

  it('rejects invalid field values before writing — create never emits a doc validate would reject', () => {
    // null counts as absent for a required field, same as validate()
    assert.throws(
      () => create('note@1', { title: null }, { registry }),
      /missing required field: title/
    );
    assert.throws(
      () => create('note@1', { title: 5 }, { registry }),
      /field 'title' must be string/
    );
    assert.throws(
      () => create('note@1', { title: 'x', status: 'bogus' }, { registry }),
      /field 'status' must be one of/
    );
  });

  it('throws on a missing required field and on unknown templates', () => {
    assert.throws(() => create('note@1', {}, { registry }), /missing required field: title/);
    assert.throws(() => create('ghost@1', {}, { registry }), /unknown template/);
  });
});

describe('createFile', () => {
  it('writes the doc and refuses to overwrite without force', () => {
    const p = join(root, 'deep/dir/doc.md');
    createFile(p, 'note@1', { title: 'A' }, { registry });
    assert.ok(existsSync(p));
    assert.throws(() => createFile(p, 'note@1', { title: 'B' }, { registry }), /file exists/);
    createFile(p, 'note@1', { title: 'B' }, { registry, force: true });
    assert.ok(readFileSync(p, 'utf8').includes('# B'));
  });
});
