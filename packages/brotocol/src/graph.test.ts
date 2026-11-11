import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { after, describe, it } from 'node:test';
import { graph } from './graph.ts';
import { lint } from './lint.ts';
import { mktree, proto, rm } from './testkit.ts';
import { tree } from './tree.ts';

const { root } = mktree({
  'spec.md': '---\nid: ROOT-0\n---\n# root\n',
  'A-1.spec.md': '---\nid: A-1\n---\n# a\n',
  'G-1.spec.md': '---\nid: G-1\nparent: GHOST\n---\n# dangling\n',
  'X-1.spec.md': '---\nid: X-1\nparent: Y-1\n---\n# x\n',
  'Y-1.spec.md': '---\nid: Y-1\nparent: X-1\n---\n# y\n',
  'feat/feat.spec.md': '---\ntitle: feat\n---\n# feat\n',
  'feat/B-1.spec.md': '---\nid: B-1\n---\n# positional child\n',
  'feat/B-2.spec.md': '---\nid: B-2\nparent: A-1\n---\n# fm child inside a dir-doc\n',
});
after(() => rm(root));

const protocol = proto(root);
const g = graph(protocol);

describe('graph', () => {
  it('resolves frontmatter edges first, positional second', () => {
    assert.deepEqual(g.edges.map(e => `${e.from}->${e.to}:${e.via}`).sort(), [
      'A-1->ROOT-0:position',
      'B-1->feat:position',
      'B-2->A-1:frontmatter',
      'X-1->Y-1:frontmatter',
      'Y-1->X-1:frontmatter',
      'feat->ROOT-0:position',
    ]);
  });

  it('reports a dangling parent and a cycle as diagnostics', () => {
    const dangling = g.diagnostics.find(d => d.rule === 'parent-not-found');
    assert.match(dangling?.message ?? '', /GHOST/);
    assert.equal(dangling?.severity, 'warn');
    const cycle = g.diagnostics.find(d => d.rule === 'cycle');
    assert.equal(cycle?.severity, 'error');
    assert.match(cycle?.message ?? '', /X-1/);
  });
});

describe('tree', () => {
  it('indents children under parents as `id  relpath`; cyclic nodes are skipped', () => {
    const name = basename(root);
    assert.deepEqual(tree(protocol), [
      `ROOT-0  ${name}/spec.md`,
      `  A-1  ${name}/A-1.spec.md`,
      `    B-2  ${name}/feat/B-2.spec.md`,
      `  feat  ${name}/feat/feat.spec.md`,
      `    B-1  ${name}/feat/B-1.spec.md`,
      `G-1  ${name}/G-1.spec.md`,
    ]);
  });
});

describe('lint', () => {
  it('flags dangling parents, cycles, and missing id fields', () => {
    const diags = lint(protocol);
    const rules = diags.map(d => d.rule);
    assert.ok(rules.includes('parent-not-found'));
    assert.ok(rules.includes('cycle'));
    // feat.spec.md carries no id: — the dirname fallback kicks in
    assert.ok(rules.includes('id-missing'));
  });

  it('flags duplicate ids', () => {
    const { root: r2 } = mktree({
      'x/dup.spec.md': '---\nid: SAME-1\n---\n# a\n',
      'y.spec.md': '---\nid: SAME-1\n---\n# b\n',
    });
    after(() => rm(r2));
    assert.ok(lint(proto(r2)).some(d => d.rule === 'duplicate-id' && d.severity === 'error'));
  });

  it('validates docs against their declared template', () => {
    const { root: r3, dir } = mktree({
      'tpls/note.md':
        '---\nname: note\nversion: 1\nfields:\n  title: { required: true }\n---\n# {{title}}\n',
      'bad.spec.md': '---\nid: B-9\ntemplate: note@1\n---\n# missing the required field\n',
    });
    after(() => rm(r3));
    const diags = lint({ ...proto(r3), templateDirs: [dir('tpls')] });
    assert.ok(diags.some(d => d.rule === 'field-required' && d.severity === 'error'));
  });
});
