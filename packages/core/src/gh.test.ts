import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, ghTry, issueLink, prLink, prRefs } from './gh.ts';

describe('prLink', () => {
  test('renders a clickable markdown link', () => {
    assert.equal(prLink('ThePlenkov/bro', 95), '[#95](https://github.com/ThePlenkov/bro/pull/95)');
  });
});

describe('prRefs', () => {
  test('the link form carries the PR and the repo', () => {
    assert.deepEqual(prRefs('merged [#958](https://github.com/ThePlenkov/bro/pull/958) today'), [
      { pr: 958, repo: 'ThePlenkov/bro' },
    ]);
  });

  test('the link form is one reference — its own #N is not a second hit', () => {
    const refs = prRefs('see [#958](https://github.com/o/r/pull/958)');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.pr, 958);
  });

  test('the bare form carries the PR and no repo', () => {
    assert.deepEqual(prRefs('PR #958 merged (squash d11788ce)'), [{ pr: 958 }]);
  });

  test('an issue link is not a PR', () => {
    assert.deepEqual(prRefs('[#12](https://github.com/o/r/issues/12)'), []);
  });

  test('two different PRs are two references', () => {
    const refs = prRefs('#958 and #959');
    assert.deepEqual(
      refs.map(r => r.pr),
      [958, 959]
    );
  });

  test('the same PR twice is one reference', () => {
    assert.equal(prRefs('#958 … #958').length, 1);
  });

  test('a zero or negative number is not a PR', () => {
    assert.deepEqual(prRefs('#0 and #-3'), []);
  });
});

describe('issueLink', () => {
  test('renders a clickable markdown link', () => {
    assert.equal(
      issueLink('ThePlenkov/bro', 95),
      '[#95](https://github.com/ThePlenkov/bro/issues/95)'
    );
  });
});

/** A `gh` on PATH that runs the given shell body — the helpers shell out,
 *  so the contract under test is what they make of a child's exit. */
function withFakeGh(body: string, fn: (log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-gh-'));
  const script = join(dir, 'gh');
  const log = join(dir, 'gh.log');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  writeFileSync(log, '');
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    fn(log);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gh failure reporting', () => {
  test('a silent failure names the exit code — an empty reason is no reason', () => {
    withFakeGh('exit 3', () => {
      assert.throws(() => gh(['api', 'repos/acme/widgets/pulls']), /gh api failed: exit 3/);
      assert.equal(ghTry(['api', 'repos/acme/widgets/pulls']).err, 'exit 3');
    });
  });

  test('a silent SUCCESS stays silent', () => {
    withFakeGh('exit 0', () => {
      assert.equal(ghTry(['api', 'repos/acme/widgets/pulls']).err, '');
    });
  });

  test("the CLI's own stderr still wins over the exit code", () => {
    withFakeGh("echo 'gh: Not Found (HTTP 404)' >&2\nexit 1", () => {
      assert.throws(() => gh(['pr', 'view', '7']), /gh pr failed: gh: Not Found/);
    });
  });

  test('a diagnosis on stdout is not lost — some tools print it there', () => {
    // the fallback order is stderr, spawn error, stdout, signal, exit —
    // a tool that prints the reason on stdout must keep it
    withFakeGh("echo 'could not resolve head ref'\nexit 1", () => {
      assert.equal(ghTry(['stack', 'link', '7']).err, 'could not resolve head ref');
    });
  });

  test('a signal-killed child names the signal, not an unknown exit', () => {
    withFakeGh('kill -TERM $$', () => {
      assert.equal(ghTry(['pr', 'view', '7']).err, 'signal SIGTERM');
    });
  });

  test('a listing past 1 MiB is not killed — Node caps spawnSync at 1 MiB', () => {
    // Node's spawnSync default maxBuffer kills the child with ENOBUFS
    // past 1 MiB: status goes null, stderr stays empty, and the caller
    // cannot tell a killed child from a quiet one. A bulk listing (the
    // open-PR REST page) crosses that cap easily.
    withFakeGh(`node -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'`, () => {
      assert.equal(gh(['api', 'repos/acme/widgets/pulls']).length, 2 * 1024 * 1024);
    });
  });
});
