import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ioWrite, resolveIn } from './io.ts';

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'brotocol-io-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('ioWrite', () => {
  it('does not follow a symlink in the final write component', () => {
    const outside = join(root, 'outside.txt');
    const link = join(root, 'link.txt');
    ioWrite(outside, 'keep\n');
    symlinkSync(outside, link);

    assert.throws(() => ioWrite(link, 'redirected\n'));
    assert.equal(ioWriteTarget(outside), 'keep\n');
  });

  it('rejects a symlinked parent when the guarded path is resolved', () => {
    const outside = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'brotocol-outside-'));
    const linked = join(root, 'linked');
    symlinkSync(outside, linked, 'dir');

    try {
      assert.throws(() => ioWrite(resolveIn(root, 'linked/new.txt'), 'escaped\n'));
      assert.equal(ioWriteTarget(join(outside, 'new.txt')), undefined);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function ioWriteTarget(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
