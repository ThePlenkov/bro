import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const pkg = join(import.meta.dirname, '..');
const bin = join(pkg, 'src/bin.ts');
const tdir = join(pkg, 'examples/templates');
const docs = join(pkg, 'examples/docs');
const out = mkdtempSync(join(tmpdir(), 'brose-bin-'));
after(() => rmSync(out, { recursive: true, force: true }));

const brose = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: out, encoding: 'utf8' });

describe('brose validate', () => {
  it('exits 0 silent on a clean doc', () => {
    const r = brose('validate', join(docs, 'rfc-001.md'), '--templates-dir', tdir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  it('exits 1 with error lines on an invalid doc', () => {
    const r = brose('validate', join(docs, 'note-002-invalid.md'), '--templates-dir', tdir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^error .*note-002-invalid\.md:1: field-required:/m);
    assert.match(r.stdout, /^error .*:\d+: section-missing:/m);
    assert.match(r.stdout, /^warn .*:\d+: template-outdated: note@2 available/m);
  });

  it('exits 1 on a doc with no template binding', () => {
    const r = brose('validate', join(docs, 'untemplated.md'), '--templates-dir', tdir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /template-missing/);
  });
});

describe('brose new', () => {
  it('writes a doc that then validates clean', () => {
    const p = join(out, 'n.md');
    const made = brose(
      'new',
      '--template',
      'note@2',
      '--out',
      p,
      '--set',
      'title=Bin note',
      '--set',
      'status=active',
      '--templates-dir',
      tdir
    );
    assert.equal(made.status, 0, made.stderr);
    assert.match(readFileSync(p, 'utf8'), /^template: note@2$/m);
    const v = brose('validate', p, '--templates-dir', tdir);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });

  it('refuses to overwrite without --force and honors --force', () => {
    const p = join(out, 'dup.md');
    const args = [
      'new',
      '--template',
      'note@1',
      '--out',
      p,
      '--set',
      'title=x',
      '--templates-dir',
      tdir,
    ];
    assert.equal(brose(...args).status, 0);
    const again = brose(...args);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /file exists/);
    assert.equal(brose(...args, '--force').status, 0);
  });

  it('fails on a missing required field value', () => {
    const r = brose(
      'new',
      '--template',
      'note@1',
      '--out',
      join(out, 'x.md'),
      '--templates-dir',
      tdir
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required field/);
  });

  it('prints usage on an unknown verb', () => {
    const r = brose('frobnicate');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage:/);
  });
});
