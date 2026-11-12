import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { create as broseCreate, createRegistry, validate } from '@broject/brose';
import { create } from './create.ts';
import { get } from './scan.ts';
import {
  keynRe,
  lintSpec,
  specFields,
  specLifecycle,
  specProtocol,
  specTemplateDir,
} from './spec.ts';
import { mktree, rm } from './testkit.ts';

describe('specProtocol', () => {
  it('describes the spec filetree', () => {
    const { root } = mktree({});
    after(() => rm(root));
    const p = specProtocol({ dir: root });
    assert.equal(p.docGlob, '**/*.spec.md');
    assert.equal(p.indexName?.('BRO-1-x'), 'BRO-1-x.spec.md');
    assert.deepEqual(p.indexAliases, ['spec.md', 'README.md']);
    assert.equal(p.idField, 'id');
    assert.equal(p.parentField, 'parent');
    assert.ok(p.templateDirs?.includes(specTemplateDir));
    assert.ok(existsSync(specTemplateDir));
  });

  it('picks up <dir>/.brose/templates when present', () => {
    const { root, dir } = mktree({ '.brose/templates/x.md': '---\nname: x\nversion: 1\n---\n' });
    after(() => rm(root));
    const p = specProtocol({ dir: root });
    assert.ok(p.templateDirs?.includes(dir('.brose/templates')));
  });
});

describe('spec template', () => {
  it('shipped registry resolves spec@1 and brotocol/spec@1', () => {
    const registry = createRegistry({ dirs: [specTemplateDir], cwd: '/nonexistent' });
    assert.equal(registry.resolve('spec@1')?.name, 'spec');
    assert.equal(registry.resolve('brotocol/spec@1')?.name, 'brotocol/spec');
    assert.equal(registry.resolve('brotocol/spec')?.version, 1);
  });

  it('create → validate round-trips against the shipped template', () => {
    const { root, dir } = mktree({});
    after(() => rm(root));
    const p = specProtocol({ dir: root });
    const doc = create(p, {
      template: 'brotocol/spec@1',
      id: 'BRO-7',
      values: { title: 'Round trip', status: 'draft', area: 'test' },
    });
    const text = readFileSync(doc.path, 'utf8');
    assert.ok(text.includes('template: brotocol/spec@1'));
    assert.ok(text.includes('# BRO-7 — Round trip'));
    assert.deepEqual(validate(doc.path, { dirs: [specTemplateDir], cwd: '/nonexistent' }), []);
    assert.equal(get(p, 'BRO-7')?.frontmatter.status, 'draft');
    assert.equal(dir('BRO-7.spec.md'), doc.path);
  });

  it('shipped template does not require a template: value — the engine pins it', () => {
    // bro-bntld.4: `template:` is engine-emitted provenance, not author
    // data — raw `brose new`/`create` must not demand a redundant --set.
    const registry = createRegistry({ dirs: [specTemplateDir], cwd: '/nonexistent' });
    const text = broseCreate(
      'brotocol/spec@1',
      { id: 'T-1', title: 'T', status: 'draft' },
      { registry }
    );
    assert.ok(text.includes('template: brotocol/spec@1'));
  });
});

describe('lintSpec', () => {
  it('enforces lifecycle status, template presence, and KEY-N ids', () => {
    const { root } = mktree({
      'good.spec.md': '---\nid: BRO-1\ntemplate: brotocol/spec@1\nstatus: draft\n---\n# good\n',
      'bad-status.spec.md': '---\nid: BRO-2\nstatus: bogus\n---\n# bad\n',
      'no-template.spec.md': '---\nid: BRO-3\n---\n# no tpl\n',
      'lowercase.spec.md': '---\ntemplate: brotocol/spec@1\n---\n# derived id\n',
    });
    after(() => rm(root));
    const diags = lintSpec(specProtocol({ dir: root }));
    const forDoc = (part: string) => diags.filter(d => d.path.endsWith(part)).map(d => d.rule);

    assert.deepEqual(forDoc('good.spec.md'), []);
    assert.ok(forDoc('bad-status.spec.md').includes('status-not-lifecycle'));
    assert.equal(diags.find(d => d.rule === 'status-not-lifecycle')?.severity, 'error');
    assert.ok(forDoc('no-template.spec.md').includes('template-missing'));
    // 'lowercase' id comes from the filename — not KEY-N
    assert.ok(forDoc('lowercase.spec.md').includes('id-not-keyn'));
    assert.equal(diags.find(d => d.rule === 'id-not-keyn')?.severity, 'warn');
  });
});

describe('spec constants', () => {
  it('carries the lifecycle and field contract', () => {
    assert.deepEqual(specLifecycle, ['draft', 'active', 'deprecated', 'removed']);
    assert.ok(specFields.includes('superseded-by'));
    assert.ok(keynRe.test('BRO-1'));
    assert.ok(!keynRe.test('bro-1'));
    assert.ok(!keynRe.test('FEAT-1.1'));
  });
});
