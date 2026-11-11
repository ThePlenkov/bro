import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { after, describe, it } from 'node:test';
import { get, scan } from './scan.ts';
import { search } from './search.ts';
import { mktree, proto, rm } from './testkit.ts';

const { root, dir } = mktree({
  // root dir-doc via a legacy index alias
  'spec.md': '---\nid: ROOT-0\n---\n# root\n',
  // a part of the root dir-doc — never a doc
  'plain.md': '# just a part\n',
  'A-1-x.spec.md': '---\nid: A-1\ntitle: Alpha\nstatus: draft\naliases: [ALPHA-9]\n---\n# A-1\n',
  // dir-doc via indexName `<dirname>.spec.md`
  'FEAT-1-x/FEAT-1-x.spec.md':
    '---\nid: FEAT-1\ntitle: Feature one\nstatus: active\n---\n# FEAT-1\n',
  // a part inside the dir-doc — never a doc
  'FEAT-1-x/notes.md': '# notes\n',
  // flat doc nested inside the dir-doc → positional child
  'FEAT-1-x/FEAT-2-y.spec.md': '---\nid: FEAT-2\nstatus: draft\n---\n# FEAT-2\n',
  // explicit frontmatter parent wins over position
  'FEAT-1-x/F-3.spec.md': '---\nid: F-3\nparent: A-1\n---\n# F-3\n',
  // transparent dir: 'deep' has no index, 'plain' inside it is a dir-doc
  'deep/plain/spec.md': '---\ntitle: Plain legacy\n---\n# plain\n',
});
after(() => rm(root));

const protocol = proto(root);
const docs = scan(protocol);
const byId = (id: string) => docs.find(d => d.id === id);

describe('scan', () => {
  it('collects flat docs and dir-docs, indexes by id', () => {
    assert.deepEqual(
      docs.map(d => d.id),
      ['ROOT-0', 'A-1', 'plain', 'FEAT-1', 'F-3', 'FEAT-2']
    );
  });

  it('a plain .md inside a dir-doc is a part, never a node', () => {
    assert.ok(!docs.some(d => basename(d.path) === 'plain.md'));
    assert.ok(!docs.some(d => basename(d.path) === 'notes.md'));
  });

  it('a dir-doc is the directory; a flat doc is a docGlob file', () => {
    assert.equal(byId('FEAT-1')?.isDirDoc, true);
    assert.equal(byId('ROOT-0')?.isDirDoc, true);
    assert.equal(byId('A-1')?.isDirDoc, false);
    assert.equal(byId('FEAT-1')?.path, dir('FEAT-1-x/FEAT-1-x.spec.md'));
  });

  it('id falls back to filename minus the doc suffix / dirname', () => {
    assert.equal(byId('plain')?.frontmatter.id, undefined);
    assert.equal(byId('plain')?.isDirDoc, true);
  });

  it('positional parentage is the nearest enclosing dir-doc', () => {
    assert.equal(byId('A-1')?.parentId, 'ROOT-0');
    assert.equal(byId('A-1')?.parentEdge, 'position');
    assert.equal(byId('FEAT-2')?.parentId, 'FEAT-1');
    assert.equal(byId('FEAT-2')?.parentEdge, 'position');
    assert.equal(byId('plain')?.parentId, 'ROOT-0');
    assert.equal(byId('ROOT-0')?.parentEdge, 'none');
  });

  it('a frontmatter parent beats the positional edge', () => {
    assert.equal(byId('F-3')?.parentId, 'A-1');
    assert.equal(byId('F-3')?.parentEdge, 'frontmatter');
  });
});

describe('get', () => {
  it('resolves by id and by aliases frontmatter', () => {
    assert.equal(get(protocol, 'FEAT-1')?.isDirDoc, true);
    assert.equal(get(protocol, 'ALPHA-9')?.id, 'A-1');
    assert.equal(get(protocol, 'ghost'), undefined);
  });
});

describe('search', () => {
  it('filters by frontmatter field equality', () => {
    assert.deepEqual(
      search(protocol, { status: 'draft' }).map(d => d.id),
      ['A-1', 'FEAT-2']
    );
    assert.deepEqual(
      search(protocol, { status: 'active' }).map(d => d.id),
      ['FEAT-1']
    );
  });

  it('matches list-typed fields by membership', () => {
    assert.deepEqual(
      search(protocol, { aliases: 'ALPHA-9' }).map(d => d.id),
      ['A-1']
    );
  });

  it('matches text over id and title (fm title or first heading)', () => {
    assert.deepEqual(
      search(protocol, { text: 'alpha' }).map(d => d.id),
      ['A-1']
    );
    // 'plain' has no fm title — the '# plain' heading carries it
    assert.deepEqual(
      search(protocol, { text: 'legacy' }).map(d => d.id),
      ['plain']
    );
    assert.deepEqual(
      search(protocol, { text: 'feat', status: 'draft' }).map(d => d.id),
      ['FEAT-2']
    );
  });
});
