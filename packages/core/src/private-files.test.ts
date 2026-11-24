/** private-files — owner-only create modes + repair-before-write on
 *  inherited permissive files (spec bro-l8c4f.4). POSIX-only semantics:
 *  skipped on win32 where modes map onto the read-only attribute. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  appendPrivateFileSync,
  mkdirPrivateSync,
  openPrivateAppendSync,
  PRIVATE_FILE_MODE,
  privateFs,
  writePrivateFileSync,
} from './private-files.ts';

const mode = (p: string): number => statSync(p).mode & 0o777;

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-private-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('private-files', { skip: process.platform === 'win32' }, () => {
  test('a new write lands 0600 under a permissive umask', () => {
    const { dir, done } = tmp();
    try {
      const prev = process.umask(0o022);
      const f = join(dir, 'prompt.md');
      writePrivateFileSync({ path: f, data: 'secret' });
      process.umask(prev);
      assert.equal(mode(f), 0o600);
      assert.equal(readFileSync(f, 'utf8'), 'secret');
    } finally {
      done();
    }
  });

  test('a pre-existing 0644 file is repaired before the write lands', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'prompt.md');
      writeFileSync0164(f);
      writePrivateFileSync({ path: f, data: 'new content' });
      assert.equal(mode(f), 0o600);
      assert.equal(readFileSync(f, 'utf8'), 'new content');
    } finally {
      done();
    }
  });

  test('append keeps content and repairs an inherited permissive mode', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'agent.log');
      writeFileSync0164(f);
      appendPrivateFileSync({ path: f, data: 'line1\n' });
      assert.equal(mode(f), 0o600);
      assert.equal(readFileSync(f, 'utf8'), 'line1\n');
      appendPrivateFileSync({ path: f, data: 'line2\n' });
      assert.equal(readFileSync(f, 'utf8'), 'line1\nline2\n');
    } finally {
      done();
    }
  });

  test('an empty append pre-creates a pinned file a later >> inherits', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'agent.log');
      appendPrivateFileSync({ path: f, data: '' });
      assert.equal(mode(f), 0o600);
    } finally {
      done();
    }
  });

  test('openPrivateAppendSync returns an fd already pinned', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'agent.stderr');
      const fd = openPrivateAppendSync({ path: f });
      try {
        assert.equal(mode(f), PRIVATE_FILE_MODE);
      } finally {
        closeSync(fd);
      }
    } finally {
      done();
    }
  });

  test('mkdirPrivateSync pins a fresh dir, leaves an existing one alone', () => {
    const { dir, done } = tmp();
    try {
      const fresh = join(dir, 'a', 'b');
      mkdirPrivateSync({ path: fresh });
      assert.equal(mode(fresh), 0o700);
      // an existing dir keeps its mode — a shared-rig dir stays usable
      const shared = join(dir, 'shared');
      mkdirPrivateSync({ path: shared });
      chmodSync(shared, 0o755);
      mkdirPrivateSync({ path: shared });
      assert.equal(mode(shared), 0o755);
    } finally {
      done();
    }
  });

  test('mkdirPrivateSync stays owner-usable under a bit-masking umask', () => {
    const { dir, done } = tmp();
    try {
      const prev = process.umask(0o177);
      const fresh = join(dir, 'x', 'y');
      try {
        mkdirPrivateSync({ path: fresh });
      } finally {
        process.umask(prev);
      }
      // 0700 & ~0177 = 0600 — a masked intermediate has no owner-x, so
      // recursive mkdir cannot even descend; each level is pinned as
      // it is created
      assert.equal(mode(fresh), 0o700);
      assert.equal(mode(join(dir, 'x')), 0o700);
      writePrivateFileSync({ path: join(fresh, 'prompt.md'), data: 'x' });
    } finally {
      done();
    }
  });

  test('the mode pin lands on the fd before the first byte', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'prompt.md');
      writeFileSync0164(f);
      const calls: Array<[string, number]> = [];
      const origChmod = privateFs.fchmod;
      const origWrite = privateFs.write;
      privateFs.fchmod = (fd: number, m: string | number) => {
        calls.push(['fchmod', fd]);
        origChmod(fd, m);
      };
      privateFs.write = (
        file: Parameters<typeof origWrite>[0],
        data: Parameters<typeof origWrite>[1]
      ) => {
        if (typeof file === 'number') {
          calls.push(['write', file]);
        }
        return origWrite(file, data);
      };
      try {
        writePrivateFileSync({ path: f, data: 'secret' });
        appendPrivateFileSync({ path: f, data: 'more' });
      } finally {
        privateFs.fchmod = origChmod;
        privateFs.write = origWrite;
      }
      // a write-before-pin implementation is detectable only in the
      // call stream — end-state assertions can't see the window
      assert.ok(calls.length > 0);
      const last = new Map<number, string>();
      for (const [op, fd] of calls) {
        if (op === 'write') {
          assert.equal(last.get(fd), 'fchmod', `write on fd ${fd} preceded the pin`);
        }
        last.set(fd, op);
      }
    } finally {
      done();
    }
  });

  test('a symlinked artifact path fails the open, never follows', () => {
    const { dir, done } = tmp();
    try {
      const target = join(dir, 'planted');
      writeFileSync(target, 'theirs');
      const link = join(dir, 'agent.log');
      symlinkSync(target, link);
      assert.throws(() => writePrivateFileSync({ path: link, data: 'secret' }), { code: 'ELOOP' });
      assert.throws(() => appendPrivateFileSync({ path: link, data: 'secret' }), { code: 'ELOOP' });
      assert.equal(readFileSync(target, 'utf8'), 'theirs');
    } finally {
      done();
    }
  });

  test('a foreign-owned artifact is refused instead of fed', () => {
    const { dir, done } = tmp();
    try {
      const f = join(dir, 'agent.log');
      writeFileSync0164(f);
      writeFileSync(f, 'theirs');
      const origFstat = privateFs.fstat;
      privateFs.fstat = ((fd: number) => {
        const st = origFstat(fd);
        return { ...st, uid: st.uid + 1 };
      }) as typeof privateFs.fstat;
      try {
        assert.throws(() => appendPrivateFileSync({ path: f, data: 'x' }), /foreign-owned/);
        assert.throws(() => writePrivateFileSync({ path: f, data: 'x' }), /foreign-owned/);
      } finally {
        privateFs.fstat = origFstat;
      }
      // the refusal closed the fd and threw before a byte could land —
      // and no O_TRUNC at open emptied the planted file either
      assert.equal(readFileSync(f, 'utf8'), 'theirs');
    } finally {
      done();
    }
  });
});

/** A permissive legacy artifact — the shape a pre-fix install leaves. */
function writeFileSync0164(path: string): void {
  writeFileSync(path, '');
  chmodSync(path, 0o644);
}
