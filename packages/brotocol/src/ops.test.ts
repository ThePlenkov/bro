import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { create } from './create.ts';
import { remove } from './remove.ts';
import { get } from './scan.ts';
import { mktree, proto, rm } from './testkit.ts';
import { update } from './update.ts';

const { root, dir } = mktree({
  'tpls/note.md':
    '---\nname: note\nversion: 1\nfields:\n  title: { required: true, type: string }\n  status: { type: string, enum: [draft, active] }\n---\n# {{title}}\n\n## Context\n',
});
after(() => rm(root));

const protocol = { ...proto(root), templateDirs: [dir('tpls')] };

describe('create', () => {
  it('renders the template, writes <id><suffix>, and refuses overwrite', () => {
    const doc = create(protocol, { template: 'note@1', id: 'N-1', values: { title: 'One' } });
    assert.equal(doc.id, 'N-1');
    assert.equal(doc.path, dir('N-1.spec.md'));
    assert.equal(doc.frontmatter.template, 'note@1');
    assert.equal(doc.frontmatter.id, 'N-1');
    assert.equal(doc.parentEdge, 'none');
    assert.throws(
      () => create(protocol, { template: 'note@1', id: 'N-1', values: { title: 'X' } }),
      /file exists/
    );
  });

  it('creates a dir-doc when dir is given', () => {
    const doc = create(protocol, {
      template: 'note@1',
      id: 'D-1',
      values: { title: 'Dir' },
      dir: 'D-1-x',
    });
    assert.equal(doc.isDirDoc, true);
    assert.equal(doc.path, dir('D-1-x/D-1-x.spec.md'));
  });

  it('a flat parent gets a frontmatter edge; a dir-doc parent gets a positional child', () => {
    create(protocol, { template: 'note@1', id: 'P-1', values: { title: 'P' } });
    const flatChild = create(protocol, {
      template: 'note@1',
      id: 'C-1',
      values: { title: 'C' },
      parent: 'P-1',
    });
    assert.equal(flatChild.frontmatter.parent, 'P-1');
    assert.equal(flatChild.parentEdge, 'frontmatter');
    assert.equal(flatChild.path, dir('C-1.spec.md'));

    const dirChild = create(protocol, {
      template: 'note@1',
      id: 'C-2',
      values: { title: 'C2' },
      parent: 'D-1',
    });
    assert.equal(dirChild.path, dir('D-1-x/C-2.spec.md'));
    assert.equal(dirChild.frontmatter.parent, undefined);
    assert.equal(dirChild.parentEdge, 'position');
    assert.equal(dirChild.parentId, 'D-1');
  });

  it('rejects an unknown template and an unknown parent', () => {
    assert.throws(() => create(protocol, { template: 'ghost@1', id: 'X-1' }), /unknown template/);
    assert.throws(
      () =>
        create(protocol, { template: 'note@1', id: 'X-2', values: { title: 'x' }, parent: 'G' }),
      /unknown parent/
    );
  });

  it('a `?`-only docGlob keeps its extension; a non-matching name refuses before write', () => {
    const { root: r2, dir: d2 } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
    });
    after(() => rm(r2));
    const q = {
      ...proto(r2),
      docGlob: '???.md',
      indexName: undefined,
      indexAliases: undefined,
      templateDirs: [d2('tpls')],
    };
    const doc = create(q, { template: 'note@1', id: 'ABC', values: { title: 't' } });
    assert.equal(doc.path, d2('ABC.md'));
    assert.throws(
      () => create(q, { template: 'note@1', id: 'TOOLONG', values: { title: 't' } }),
      /does not match docGlob/
    );
    assert.ok(!existsSync(d2('TOOLONG.md')));
  });

  it('a dir-doc parent drops a caller-supplied parent field — the edge stays positional', () => {
    const { root: r4, dir: d4 } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
      'P-2-x/P-2-x.spec.md': '---\nid: P-2\n---\n# p\n',
    });
    after(() => rm(r4));
    const p = { ...proto(r4), templateDirs: [d4('tpls')] };
    const child = create(p, {
      template: 'note@1',
      id: 'C-9',
      values: { title: 'c', parent: 'WRONG-9' },
      parent: 'P-2',
    });
    assert.equal(child.frontmatter.parent, undefined);
    assert.equal(child.parentEdge, 'position');
    assert.equal(child.parentId, 'P-2');
  });

  it('a dir with a legacy index refuses a second canonical index', () => {
    const { root: r5, dir: d5 } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
      'D-9-x/spec.md': '---\nid: D-9\n---\n# legacy dir-doc\n',
    });
    after(() => rm(r5));
    const p = { ...proto(r5), templateDirs: [d5('tpls')] };
    assert.throws(
      () => create(p, { template: 'note@1', id: 'E-9', values: { title: 't' }, dir: 'D-9-x' }),
      /already has index 'spec.md'/
    );
  });

  it('a symlinked root writes where scan looks — same path spelling', () => {
    const { root: real, dir: rd } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
    });
    const { root: linkBase } = mktree({});
    after(() => {
      rm(real);
      rm(linkBase);
    });
    const link = join(linkBase, 'specs-link');
    symlinkSync(real, link, 'dir');
    const p = { ...proto(link), templateDirs: [rd('tpls')] };
    const doc = create(p, { template: 'note@1', id: 'L-1', values: { title: 't' } });
    assert.equal(doc.path, join(link, 'L-1.spec.md'));
    assert.equal(get(p, 'L-1')?.id, 'L-1');
  });

  it('a symlink inside the root cannot point a write outside it', () => {
    const { root: r3, dir: d3 } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
    });
    const { root: outside } = mktree({});
    after(() => {
      rm(r3);
      rm(outside);
    });
    symlinkSync(outside, d3('escape'), 'dir');
    assert.throws(
      () =>
        create(
          { ...proto(r3), templateDirs: [d3('tpls')] },
          { template: 'note@1', id: 'E-1', values: { title: 't' }, dir: 'escape' }
        ),
      /escapes the tree/
    );
    assert.ok(!existsSync(join(outside, 'escape.spec.md')));
  });
});

describe('update', () => {
  it('rewrites only the frontmatter block — body bytes untouched', () => {
    create(protocol, { template: 'note@1', id: 'U-1', values: { title: 'U', status: 'draft' } });
    const before = readFileSync(dir('U-1.spec.md'), 'utf8');
    const fmEnd = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(before)?.[0].length ?? 0;
    const body = before.slice(fmEnd);
    const doc = update(protocol, 'U-1', { status: 'active', area: 'spec' });
    const afterText = readFileSync(dir('U-1.spec.md'), 'utf8');
    assert.ok(afterText.endsWith(body));
    assert.equal(doc.frontmatter.status, 'active');
    assert.equal(doc.frontmatter.area, 'spec');
    assert.equal(doc.frontmatter.id, 'U-1');
    assert.equal(doc.frontmatter.title, 'U');
  });

  it('deletes a field set to undefined', () => {
    const doc = update(protocol, 'U-1', { area: undefined });
    assert.equal(doc.frontmatter.area, undefined);
    assert.ok(!readFileSync(dir('U-1.spec.md'), 'utf8').includes('area:'));
  });

  it('the id field cannot be deleted, non-string, or collide', () => {
    create(protocol, { template: 'note@1', id: 'I-1', values: { title: 'i' } });
    create(protocol, { template: 'note@1', id: 'I-2', values: { title: 'j' } });
    assert.throws(() => update(protocol, 'I-1', { id: undefined }), /identity/);
    assert.throws(() => update(protocol, 'I-1', { id: 'I-2' }), /already held/);
    assert.throws(() => update(protocol, 'I-1', { id: 5 }), /non-empty string/);
    // re-writing the same id is a no-op, not a conflict
    update(protocol, 'I-1', { id: 'I-1' });
    assert.equal(get(protocol, 'I-1')?.id, 'I-1');
  });

  it('refuses an id rename while frontmatter children reference the old id', () => {
    create(protocol, { template: 'note@1', id: 'M-P', values: { title: 'p' } });
    create(protocol, {
      template: 'note@1',
      id: 'M-C',
      values: { title: 'c' },
      parent: 'M-P',
    });
    assert.throws(() => update(protocol, 'M-P', { id: 'M-P2' }), /reparent/);
    assert.equal(get(protocol, 'M-P')?.id, 'M-P');
    // positional children re-derive parentage — a dir-doc rename stays legal
    create(protocol, { template: 'note@1', id: 'M-D', values: { title: 'd' }, dir: 'M-D-x' });
    create(protocol, { template: 'note@1', id: 'M-D-c', values: { title: 'dc' }, parent: 'M-D' });
    const renamed = update(protocol, 'M-D', { id: 'M-D2' });
    assert.equal(renamed.id, 'M-D2');
    assert.equal(get(protocol, 'M-D-c')?.parentId, 'M-D2');
  });

  it('throws on an unknown doc', () => {
    assert.throws(() => update(protocol, 'ghost', {}), /unknown doc/);
  });
});

describe('remove', () => {
  it('deletes a flat doc', () => {
    create(protocol, { template: 'note@1', id: 'R-1', values: { title: 'R' } });
    remove(protocol, 'R-1');
    assert.equal(get(protocol, 'R-1'), undefined);
    assert.ok(!existsSync(dir('R-1.spec.md')));
  });

  it('non-recursive dir-doc removal refuses while positional children exist', () => {
    create(protocol, { template: 'note@1', id: 'R-9', values: { title: 'r' }, dir: 'R-9-x' });
    create(protocol, { template: 'note@1', id: 'R-9-c', values: { title: 'c' }, parent: 'R-9' });
    assert.throws(() => remove(protocol, 'R-9'), /positional children/);
    remove(protocol, 'R-9', { recursive: true });
    assert.ok(!existsSync(dir('R-9-x')));
  });

  it('a dir-doc loses its index only unless recursive', () => {
    create(protocol, { template: 'note@1', id: 'R-2', values: { title: 'R2' }, dir: 'R-2-x' });
    writeFileSync(dir('R-2-x/keep.md'), '# keep\n');
    remove(protocol, 'R-2');
    assert.ok(!existsSync(dir('R-2-x/R-2-x.spec.md')));
    assert.ok(existsSync(dir('R-2-x/keep.md')));
    const again = create(protocol, {
      template: 'note@1',
      id: 'R-2',
      values: { title: 'R2' },
      dir: 'R-2-x',
    });
    assert.ok(again.isDirDoc);
    remove(protocol, 'R-2', { recursive: true });
    assert.ok(!existsSync(dir('R-2-x')));
  });

  it('refuses recursive removal of the protocol root through its index doc', () => {
    const { root: r4, dir: d4 } = mktree({ 'spec.md': '---\nid: ROOT-1\n---\n# root\n' });
    try {
      assert.throws(() => remove(proto(r4), 'ROOT-1', { recursive: true }), /tree root/);
      assert.ok(existsSync(d4('spec.md')));
    } finally {
      rm(r4);
    }
  });
});
