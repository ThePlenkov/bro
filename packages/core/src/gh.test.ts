import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, ghTry, issueLink, osc8Link, prLink, prLinkTerm, prRefs, supportsOsc8 } from './gh.ts';

describe('prLink', () => {
  test('renders a clickable markdown link', () => {
    assert.equal(prLink('ThePlenkov/bro', 95), '[#95](https://github.com/ThePlenkov/bro/pull/95)');
  });
});

describe('prRefs', () => {
  test('the link form carries the PR, the repo and the host', () => {
    assert.deepEqual(prRefs('merged [#958](https://github.com/ThePlenkov/bro/pull/958) today'), [
      { pr: 958, repo: 'ThePlenkov/bro', host: 'github.com' },
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

  test('hostile text is parsed, not hung on', () => {
    // a long run of `[` is what a regex scan chokes on — the parser is
    // a string walk, so the answer is the same, and fast
    assert.deepEqual(prRefs(`${'['.repeat(20000)}#958`), [{ pr: 958 }]);
  });

  test('a link whose label holds a bracket is not a link', () => {
    assert.deepEqual(prRefs('[[a]](https://github.com/o/r/pull/12)'), []);
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

describe('osc8 terminal links (bro-8gh0t)', () => {
  test('supportsOsc8 is false off a TTY even for a known terminal', () => {
    assert.equal(supportsOsc8({ TERM_PROGRAM: 'ghostty' }, false), false);
  });
  test('supportsOsc8 is true on a TTY for ghostty/wezterm/iterm/kitty', () => {
    for (const termProgram of ['ghostty', 'WezTerm', 'iTerm.app', 'vscode']) {
      assert.equal(supportsOsc8({ TERM_PROGRAM: termProgram }, true), true);
    }
    assert.equal(supportsOsc8({ TERM: 'xterm-kitty' }, true), true);
  });
  test('supportsOsc8 is false for unknown terminals — never escape junk', () => {
    assert.equal(
      supportsOsc8({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, true),
      false
    );
    assert.equal(supportsOsc8({}, true), false);
  });
  test('osc8Link wraps text in the hyperlink sequence when supported', () => {
    const out = osc8Link('https://github.com/o/r/pull/7', '#7', { TERM_PROGRAM: 'ghostty' }, true);
    assert.equal(out, '\x1b]8;;https://github.com/o/r/pull/7\x07#7\x1b]8;;\x07');
  });
  test('osc8Link falls back to plain text when unsupported', () => {
    assert.equal(osc8Link('https://x', '#7', {}, false), '#7');
  });
  test('osc8Link strips control characters from url and text (review #1254)', () => {
    const out = osc8Link('https://x/\u0007evil', 'a\u001bb', { TERM_PROGRAM: 'ghostty' }, true);
    assert.equal(out, '\x1b]8;;https://x/evil\x07ab\x1b]8;;\x07');
  });
  test('prLinkTerm stays the markdown form off a supporting terminal', () => {
    assert.equal(prLinkTerm('o/r', 42, 'github.com'), '[#42](https://github.com/o/r/pull/42)');
  });
});
