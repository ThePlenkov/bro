/** Dogfood — the real `specs/` tree of this repo under the spec
 *  protocol. Assertions stay existence+edge level so new spec docs
 *  don't break the test. */
import assert from 'node:assert/strict';
import { basename, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { graph } from './graph.ts';
import { scan } from './scan.ts';
import { specProtocol } from './spec.ts';
import { tree } from './tree.ts';

const protocol = specProtocol({ dir: resolve(import.meta.dirname, '../../../specs') });

describe('spec protocol on the real specs/ tree', () => {
  const docs = scan(protocol);

  it('resolves BRO-1 as a doc nested under sdd', () => {
    const bro1 = docs.find(d => d.id === 'BRO-1');
    assert.ok(bro1 !== undefined);
    assert.equal(bro1.isDirDoc, true);
    assert.equal(bro1.parentId, 'sdd');
    assert.equal(bro1.parentEdge, 'position');
    assert.ok(docs.some(d => d.id === 'sdd' && d.isDirDoc));
  });

  it('a part file is never a node — emulation.md is content', () => {
    assert.ok(!docs.some(d => basename(d.path) === 'emulation.md'));
    // and neither are the legacy flat bro-*.md records inside dir-docs
    assert.ok(!docs.some(d => basename(d.path) === 'bro-y1jtm.md'));
  });

  it('the graph carries a BRO-1 -> sdd edge', () => {
    const g = graph(protocol);
    assert.ok(g.edges.some(e => e.from === 'BRO-1' && e.to === 'sdd'));
  });

  it('tree indents BRO-1 under sdd', () => {
    const lines = tree(protocol);
    const sddIdx = lines.findIndex(l => /^sdd {2}/.test(l));
    const bro1Idx = lines.findIndex(l => /^ {2}BRO-1 {2}/.test(l));
    assert.ok(sddIdx !== -1, `sdd row missing:\n${lines.join('\n')}`);
    assert.ok(bro1Idx > sddIdx, `BRO-1 row missing or not nested:\n${lines.join('\n')}`);
  });
});
