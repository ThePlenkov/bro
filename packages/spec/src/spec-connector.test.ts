import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectorCtx } from '@broject/core';
import { specConnector } from './spec-connector.ts';

const SPEC_DOC = `---
template: brotocol/spec@1
id: ID
status: draft
---

# ID — title

## Problem

## Design

## Requirements

## Verify
`;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-conn-'));
  mkdirSync(join(dir, 'specs', 'sdd', 'BRO-1-core'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'sdd', 'spec.md'), '# sdd specs\n');
  writeFileSync(
    join(dir, 'specs', 'sdd', 'BRO-1-core', 'BRO-1-core.spec.md'),
    SPEC_DOC.replaceAll('ID', 'BRO-1')
  );
  writeFileSync(
    join(dir, 'specs', 'sdd', 'BRO-1-core', 'BRO-1-core.emulation.md'),
    '# emulation part — not a doc\n'
  );
  writeFileSync(
    join(dir, 'specs', 'sdd', 'FEAT-2-flat.spec.md'),
    `---\ntemplate: brotocol/spec@1\nid: FEAT-2\nstatus: draft\nparent: BRO-1\nowns: [packages/x]\n---\n\n# FEAT-2 — flat\n\n## Problem\n\n## Design\n\n## Requirements\n\n## Verify\n`
  );
  writeFileSync(join(dir, 'specs', 'legacy-one.md'), '# legacy flat spec\n');
  mkdirSync(join(dir, 'specs', 'LEG-3-dir'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'LEG-3-dir', 'spec.md'), '# legacy dir spec\n');
  return dir;
}

const ctx = (dir: string): ConnectorCtx => ({ dir }) as ConnectorCtx;
const store = (dir: string) => specConnector.specs!(ctx(dir));

test('matchDir claims a tree containing *.spec.md', () => {
  assert.equal(specConnector.matchDir!(fixture()), true);
});

test('matchDir declines a legacy-only tree and a missing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-conn-legacy-'));
  mkdirSync(join(dir, 'specs'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'bro-1.md'), '# old style\n');
  assert.equal(specConnector.matchDir!(dir), false);
  assert.equal(specConnector.matchDir!(mkdtempSync(join(tmpdir(), 'spec-conn-none-'))), false);
});

test('hasSpec resolves protocol docs, aliases and the legacy bridge', () => {
  const s = store(fixture());
  assert.equal(s.hasSpec('BRO-1'), true); // frontmatter id on a dir-doc
  assert.equal(s.hasSpec('FEAT-2'), true); // flat .spec.md
  assert.equal(s.hasSpec('LEG-3-dir'), true); // legacy dir index → protocol doc
  assert.equal(s.hasSpec('legacy-one'), true); // legacy flat .md bridge
  assert.equal(s.hasSpec('nope'), false);
});

test('tree merges protocol docs over the legacy index, no dangling parents', () => {
  const nodes = store(fixture()).tree();
  const byId = new Map(nodes.map(n => [n.id, n]));
  assert.equal(byId.get('BRO-1')?.parentVia, 'position'); // inside sdd dir-doc
  assert.equal(byId.get('FEAT-2')?.parent, 'BRO-1');
  assert.equal(byId.get('FEAT-2')?.parentVia, 'frontmatter');
  assert.equal(byId.get('LEG-3-dir')?.parentVia, undefined); // root-level dir-doc, no parent
  // the legacy index sees the emulation part as a child spec; the
  // dir-spec id it hung off ('BRO-1-core') was claimed by the
  // frontmatter-id protocol doc, so the orphan fixup re-parents it
  const emu = byId.get('BRO-1-core.emulation');
  assert.equal(emu?.parent, 'BRO-1');
  assert.equal(emu?.parentVia, 'position');
  assert.equal(byId.has('legacy-one'), true); // legacy flat spec still indexed
  assert.ok(nodes.every(n => n.parent === undefined || byId.has(n.parent)));
  assert.ok(nodes.every(n => n.path !== undefined && !n.path.startsWith('/')));
});

test('scaffold renders brotocol/spec@1 through brose create', () => {
  const dir = fixture();
  const s = store(dir);
  const path = s.scaffold!('bro-new1', { title: 'A new spec' });
  assert.ok(path.endsWith(join('specs', 'bro-new1.spec.md')), path);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /template: brotocol\/spec@1/);
  assert.match(text, /id: bro-new1/);
  assert.match(text, /status: draft/);
  assert.equal(s.hasSpec('bro-new1'), true);
  assert.throws(
    () => s.scaffold!('bro-new1', {}),
    /file exists|already exists|already in the tree/
  );
});

test('scaffold parent: dir-doc parent nests positionally, flat parent writes frontmatter', () => {
  const dir = fixture();
  const s = store(dir);
  const flat = s.scaffold!('bro-child1', { parent: 'BRO-1', title: 'child' });
  assert.ok(flat.includes(join('BRO-1-core')), flat);
  const orphan = s.scaffold!('bro-child2', { title: 'orphan' });
  assert.ok(orphan.endsWith(join('specs', 'bro-child2.spec.md')));
  assert.throws(() => s.scaffold!('bro-child3', { parent: 'ghost' }), /unknown parent/);
});

test('scope reads owns frontmatter; remedy and policy name the engine', () => {
  const s = store(fixture());
  assert.deepEqual(s.scope!('FEAT-2'), ['packages/x']);
  assert.equal(s.scope!('BRO-1'), null);
  assert.equal(s.scope!('nope'), null);
  assert.match(s.remedy('x'), /bro spec new x/);
  assert.match(s.policy(), /spec before code/);
});
