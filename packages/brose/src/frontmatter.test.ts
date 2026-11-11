import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dumpFrontmatter, parseFrontmatter, scalarValue } from './frontmatter.ts';

const fm = (src: string) => parseFrontmatter(`---\n${src}---\n\nbody\n`);

describe('scalars', () => {
  it('types bare values', () => {
    const { data } = fm('a: x\nb: 3\nc: 1.5\nd: true\ne: false\nf: null\ng: ~\n');
    assert.deepEqual(data, { a: 'x', b: 3, c: 1.5, d: true, e: false, f: null, g: null });
  });

  it('handles quoted strings and comments', () => {
    const { data } = fm(
      "a: \"quoted # not a comment\" # tail\nb: 'it''s'\nc: docs/it's.md # note\nd: \"#\"\n"
    );
    assert.equal(data.a, 'quoted # not a comment');
    assert.equal(data.b, "it's");
    assert.equal(data.c, "docs/it's.md");
    assert.equal(data.d, '#');
  });

  it('keeps urls as scalars, not keys', () => {
    assert.equal(scalarValue('http://x'), 'http://x');
    assert.deepEqual(fm('link: http://x\n').data, { link: 'http://x' });
  });
});

describe('collections', () => {
  it('parses flow lists incl. empty and quoted', () => {
    const { data } = fm('a: []\nb: [x, y]\nc: ["a,b", \'c\']\n');
    assert.deepEqual(data.a, []);
    assert.deepEqual(data.b, ['x', 'y']);
    assert.deepEqual(data.c, ['a,b', 'c']);
  });

  it('parses block lists', () => {
    const { data } = fm('owns:\n  - a.ts\n  - b.ts\n');
    assert.deepEqual(data.owns, ['a.ts', 'b.ts']);
  });

  it('parses same-indent block lists', () => {
    const { data } = fm('owns:\n- a.ts\n- b.ts\nnext: 1\n');
    assert.deepEqual(data.owns, ['a.ts', 'b.ts']);
    assert.equal(data.next, 1);
  });

  it('parses flow maps and nested block maps', () => {
    const { data } = fm(
      'a: {required: true, type: string}\nfields:\n  title:\n    required: true\n    type: string\n  status: {type: string, enum: [draft, active]}\n'
    );
    assert.deepEqual(data.a, { required: true, type: 'string' });
    assert.deepEqual(data.fields, {
      title: { required: true, type: 'string' },
      status: { type: 'string', enum: ['draft', 'active'] },
    });
  });

  it('parses lists of maps', () => {
    const { data } = fm('items:\n  - name: a\n    v: 1\n  - name: b\n    v: 2\n');
    assert.deepEqual(data.items, [
      { name: 'a', v: 1 },
      { name: 'b', v: 2 },
    ]);
  });

  it('joins a wrapped flow list', () => {
    const { data } = fm('a: [\n  one, # c\n  two]\n');
    assert.deepEqual(data.a, ['one', 'two']);
  });
});

describe('parseFrontmatter', () => {
  it('parses the BRO-1 spec frontmatter shape', () => {
    const { data, keyLines } = parseFrontmatter(`---
template: brotocol/spec@1
id: BRO-1
title: Brotocol — bro's native spec engine
status: draft
area: sdd
owns:
  - packages/core/src/specs.ts
  - packages/cli/src/spec-connectors.ts
  - packages/brose
aliases: []
---

# BRO-1
`);
    assert.equal(data.template, 'brotocol/spec@1');
    assert.equal(data.id, 'BRO-1');
    assert.equal(data.title, "Brotocol — bro's native spec engine");
    assert.deepEqual(data.owns, [
      'packages/core/src/specs.ts',
      'packages/cli/src/spec-connectors.ts',
      'packages/brose',
    ]);
    assert.deepEqual(data.aliases, []);
    assert.equal(keyLines.get('template'), 1);
    assert.equal(keyLines.get('owns'), 6);
  });

  it('returns empty data and the content as body without frontmatter', () => {
    const { data, body, bodyOffset } = parseFrontmatter('# title\n\ntext\n');
    assert.deepEqual(data, {});
    assert.equal(body, '# title\n\ntext\n');
    assert.equal(bodyOffset, 0);
  });

  it('reports the body offset past the frontmatter block', () => {
    const { body, bodyOffset } = parseFrontmatter('---\na: 1\n---\n# h\n');
    assert.equal(bodyOffset, 3);
    assert.equal(body, '# h\n');
  });
});

describe('dumpFrontmatter', () => {
  it('round-trips the create() shape', () => {
    const data = {
      template: 'note@1',
      title: 'x',
      owns: ['a.ts', 'b.ts'],
      aliases: [] as string[],
      meta: { a: 1 },
      n: 3,
      ok: true,
    };
    const dumped = dumpFrontmatter(data);
    assert.match(dumped, /^template: note@1\n/m);
    assert.deepEqual(parseFrontmatter(`---\n${dumped}---\n`).data, data);
  });

  it('quotes values that would misread bare', () => {
    const data = { a: 'true', b: '1.5', c: 'x: y', d: '-z', e: 'a#b' };
    const dumped = dumpFrontmatter(data);
    assert.match(dumped, /a: 'true'/);
    assert.match(dumped, /b: '1\.5'/);
    assert.match(dumped, /c: 'x: y'/);
    assert.match(dumped, /d: '-z'/);
    assert.match(dumped, /e: 'a#b'/);
    assert.deepEqual(parseFrontmatter(`---\n${dumped}---\n`).data, data);
  });
});
