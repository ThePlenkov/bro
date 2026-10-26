import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  gitCommonDir,
  gitCommonDirAsync,
  gitDriftRef,
  gitIsAncestor,
  gitIsShallow,
  gitLogPathRecords,
  gitLogStamp,
  gitUpstreamBehind,
  gitUpstreamBehindAsync,
  gitTryAsync,
  gitWorktreeRoots,
  mainWorktreeRoot,
  unquoteGitPath,
} from './git.ts';
import { scrubEnv, testGit } from './testkit.ts';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

function git(cwd: string, args: string[]): string {
  return testGit(['-C', cwd, ...args]).trim();
}

/** mkdtemp repo on `branch` with git identity and one commit. */
function makeRepo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-git-'));
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['commit', '-qm', 'init', '--allow-empty']);
  return dir;
}

function commit(dir: string, subject: string, files: Record<string, string>): string {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', subject]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function withRepo<T>(fn: (dir: string) => T, branch = 'main'): T {
  const dir = makeRepo(branch);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gitCommonDir cache', () => {
  test('reuses a successful result without spawning git again', () => {
    const dir = makeRepo();
    const bin = mkdtempSync(join(tmpdir(), 'bro-git-common-bin-'));
    const marker = join(bin, 'spawned');
    const previousPath = process.env.PATH;
    const previousMarker = process.env.BRO_GIT_COMMON_DIR_MARKER;
    try {
      const expected = gitCommonDir(dir);
      assert.ok(expected);
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\nprintf spawned > "$BRO_GIT_COMMON_DIR_MARKER"\nexit 1\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_MARKER = marker;
      process.env.PATH = [bin, previousPath].filter(Boolean).join(':');

      assert.equal(gitCommonDir(dir), expected);
      assert.equal(existsSync(marker), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.BRO_GIT_COMMON_DIR_MARKER;
      else process.env.BRO_GIT_COMMON_DIR_MARKER = previousMarker;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not cache null for a directory initialized later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-common-late-init-'));
    try {
      assert.equal(gitCommonDir(dir), null);
      git(dir, ['init', '-q', '-b', 'main']);
      assert.ok(gitCommonDir(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('briefly caches timeouts without spawning git again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-common-timeout-'));
    const bin = mkdtempSync(join(tmpdir(), 'bro-git-common-timeout-bin-'));
    const marker = join(bin, 'spawned');
    const previousPath = process.env.PATH;
    const previousMarker = process.env.BRO_GIT_COMMON_DIR_MARKER;
    try {
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\nprintf x >> "$BRO_GIT_COMMON_DIR_MARKER"\nexec /bin/sleep 30\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_MARKER = marker;
      process.env.PATH = [bin, previousPath].filter(Boolean).join(':');

      const startedAt = Date.now();
      assert.equal(gitCommonDir(dir, 200), null);
      assert.ok(Date.now() - startedAt >= 180);
      const firstMarker = readFileSync(marker, 'utf8');
      assert.equal(firstMarker.length, 1);

      const retryStartedAt = Date.now();
      assert.equal(gitCommonDir(dir, 100), null);
      assert.ok(Date.now() - retryStartedAt < 100);
      assert.equal(readFileSync(marker, 'utf8'), firstMarker);

      const equalBudgetStartedAt = Date.now();
      assert.equal(gitCommonDir(dir, 200), null);
      assert.ok(Date.now() - equalBudgetStartedAt < 100);
      assert.equal(readFileSync(marker, 'utf8'), firstMarker);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.BRO_GIT_COMMON_DIR_MARKER;
      else process.env.BRO_GIT_COMMON_DIR_MARKER = previousMarker;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not reuse a timeout null for an unbounded call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-common-unbounded-'));
    const bin = mkdtempSync(join(tmpdir(), 'bro-git-common-unbounded-bin-'));
    const marker = join(bin, 'spawned');
    const stub = join(bin, 'git');
    const previousPath = process.env.PATH;
    const previousMarker = process.env.BRO_GIT_COMMON_DIR_MARKER;
    const previousValue = process.env.BRO_GIT_COMMON_DIR_VALUE;
    try {
      writeFileSync(
        stub,
        '#!/bin/sh\nprintf x >> "$BRO_GIT_COMMON_DIR_MARKER"\nexec /bin/sleep 30\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_MARKER = marker;
      process.env.PATH = [bin, previousPath].filter(Boolean).join(':');

      assert.equal(gitCommonDir(dir, 200), null);
      const firstMarker = readFileSync(marker, 'utf8');
      assert.equal(firstMarker.length, 1);

      writeFileSync(
        stub,
        '#!/bin/sh\nprintf x >> "$BRO_GIT_COMMON_DIR_MARKER"\nprintf "%s\\n" "$BRO_GIT_COMMON_DIR_VALUE"\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_VALUE = dir;

      assert.equal(gitCommonDir(dir), dir);
      assert.equal(readFileSync(marker, 'utf8'), `${firstMarker}x`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.BRO_GIT_COMMON_DIR_MARKER;
      else process.env.BRO_GIT_COMMON_DIR_MARKER = previousMarker;
      if (previousValue === undefined) delete process.env.BRO_GIT_COMMON_DIR_VALUE;
      else process.env.BRO_GIT_COMMON_DIR_VALUE = previousValue;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-probes when the cached common directory no longer exists', () => {
    const dir = makeRepo();
    const bin = mkdtempSync(join(tmpdir(), 'bro-git-common-deleted-bin-'));
    const marker = join(bin, 'spawned');
    const previousPath = process.env.PATH;
    const previousMarker = process.env.BRO_GIT_COMMON_DIR_MARKER;
    try {
      const common = gitCommonDir(dir);
      assert.ok(common);
      rmSync(common, { recursive: true, force: true });

      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\nprintf x >> "$BRO_GIT_COMMON_DIR_MARKER"\nexit 1\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_MARKER = marker;
      process.env.PATH = [bin, previousPath].filter(Boolean).join(':');

      assert.equal(gitCommonDir(dir), null);
      assert.equal(readFileSync(marker, 'utf8').length, 2);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.BRO_GIT_COMMON_DIR_MARKER;
      else process.env.BRO_GIT_COMMON_DIR_MARKER = previousMarker;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitCommonDirAsync', () => {
  test('resolves the same common dir as the sync twin — linked worktree included', async () => {
    const dir = makeRepo();
    const linked = mkdtempSync(join(tmpdir(), 'bro-git-acommon-linked-'));
    try {
      assert.equal(await gitCommonDirAsync(dir), gitCommonDir(dir));
      git(dir, ['worktree', 'add', '-q', linked, '-b', 'work/async-common']);
      assert.equal(await gitCommonDirAsync(linked), gitCommonDir(dir));
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('null outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-acommon-norepo-'));
    try {
      assert.equal(await gitCommonDirAsync(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shares the sync cache — a warm sync probe serves the async read', async () => {
    const dir = makeRepo();
    const bin = mkdtempSync(join(tmpdir(), 'bro-git-acommon-bin-'));
    const marker = join(bin, 'spawned');
    const previousPath = process.env.PATH;
    const previousMarker = process.env.BRO_GIT_COMMON_DIR_MARKER;
    try {
      const expected = gitCommonDir(dir);
      assert.ok(expected);
      writeFileSync(
        join(bin, 'git'),
        '#!/bin/sh\nprintf spawned > "$BRO_GIT_COMMON_DIR_MARKER"\nexit 1\n',
        { mode: 0o755 }
      );
      process.env.BRO_GIT_COMMON_DIR_MARKER = marker;
      process.env.PATH = [bin, previousPath].filter(Boolean).join(':');

      assert.equal(await gitCommonDirAsync(dir), expected);
      assert.equal(existsSync(marker), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.BRO_GIT_COMMON_DIR_MARKER;
      else process.env.BRO_GIT_COMMON_DIR_MARKER = previousMarker;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitDriftRef', () => {
  test('origin/HEAD wins when the remote default is set', () => {
    withRepo(dir => {
      const remote = mkdtempSync(join(tmpdir(), 'bro-git-remote-'));
      try {
        git(remote, ['init', '-q', '--bare', '-b', 'main']);
        git(dir, ['remote', 'add', 'origin', remote]);
        git(dir, ['push', '-q', 'origin', 'main']);
        git(dir, ['remote', 'set-head', 'origin', 'main']);
        assert.equal(gitDriftRef(dir), 'refs/remotes/origin/HEAD');
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  test('no remote falls back to local main, then master, then HEAD', () => {
    withRepo(dir => assert.equal(gitDriftRef(dir), 'refs/heads/main'));
    withRepo(dir => assert.equal(gitDriftRef(dir), 'refs/heads/master'), 'master');
    withRepo(dir => {
      git(dir, ['checkout', '-qb', 'develop']);
      git(dir, ['branch', '-qD', 'main']);
      assert.equal(gitDriftRef(dir), 'HEAD');
    });
  });

  test('a tag named main cannot stand in for the branch', () => {
    withRepo(dir => {
      git(dir, ['checkout', '-qb', 'develop']);
      git(dir, ['branch', '-qD', 'main']);
      git(dir, ['tag', 'main']);
      assert.equal(gitDriftRef(dir), 'HEAD');
    });
  });

  test('remote-tracking main covers a checkout with no local default branch', () => {
    withRepo(dir => {
      const remote = mkdtempSync(join(tmpdir(), 'bro-git-remote-'));
      try {
        git(remote, ['init', '-q', '--bare', '-b', 'main']);
        git(dir, ['remote', 'add', 'origin', remote]);
        git(dir, ['push', '-q', 'origin', 'main']);
        git(dir, ['fetch', '-q', 'origin']);
        // a CI checkout shape: remote-tracking main exists but no
        // origin/HEAD symref. set-head creates it deterministically
        // (newer git may have already; older never does) so the delete
        // can't fail on a missing ref — and symbolic-ref -d, not
        // update-ref -d, which would dereference and drop origin/main
        git(dir, ['remote', 'set-head', 'origin', 'main']);
        git(dir, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']);
        git(dir, ['checkout', '-qb', 'develop']);
        git(dir, ['branch', '-qD', 'main']);
        assert.equal(gitDriftRef(dir), 'refs/remotes/origin/main');
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  test('unborn history resolves nothing — null, not a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      assert.equal(gitDriftRef(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitLogStamp', () => {
  test('newest commit over the pathspecs, sha + ts + iso', () => {
    withRepo(dir => {
      commit(dir, 'one', { 'src/a.ts': 'a\n' });
      const newer = commit(dir, 'two', { 'src/b.ts': 'b\n' });
      const r = gitLogStamp(dir, 'HEAD', ['src/']);
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`);
      }
      assert.equal(r.stamp.sha, newer);
      assert.ok(r.stamp.ts > 0);
      assert.ok(!Number.isNaN(Date.parse(r.stamp.iso)));
    });
  });

  test('exclude pathspecs subtract their commits from the result', () => {
    withRepo(dir => {
      const kept = commit(dir, 'code', { 'src/a.ts': 'a\n' });
      commit(dir, 'spec', { 'specs/x.md': '# x\n' });
      const r = gitLogStamp(dir, 'HEAD', ['.', ':(exclude,literal)specs/x.md']);
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`);
      }
      assert.equal(r.stamp.sha, kept);
    });
  });

  test('a path with no commits is none — missing spec file stays honest', () => {
    withRepo(dir => {
      assert.deepEqual(gitLogStamp(dir, 'HEAD', ['specs/never.md']), { state: 'none' });
    });
  });

  test('empty pathspecs are an error — never a whole-repo audit', () => {
    withRepo(dir => {
      const r = gitLogStamp(dir, 'HEAD', []);
      assert.equal(r.state, 'error');
      assert.match(r.state === 'error' ? r.err : '', /empty pathspecs/);
    });
  });

  test('a dash-prefixed ref is an error, not a git log option', () => {
    withRepo(dir => {
      commit(dir, 'one', { 'src/a.ts': 'a\n' });
      assert.equal(gitLogStamp(dir, '--all', ['src/']).state, 'error');
    });
  });

  test('a bad ref and unborn history are error, not throw', () => {
    withRepo(dir => {
      const r = gitLogStamp(dir, 'nonexistent-ref', ['src/']);
      assert.equal(r.state, 'error');
    });
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      assert.equal(gitLogStamp(dir, 'HEAD', ['.']).state, 'error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a renamed spec stamps the last content write, not the move', () => {
    withRepo(dir => {
      const written = commit(dir, 'spec', { 'specs/x.md': '# x\n' });
      mkdirSync(join(dir, 'specs', 'x'), { recursive: true });
      renameSync(join(dir, 'specs', 'x.md'), join(dir, 'specs', 'x', 'spec.md'));
      const renamed = commit(dir, 'move spec', {});
      // --follow --diff-filter=r drops the pure-rename commit: a spec
      // merely moved yesterday must not look freshly written
      const r = gitLogStamp(dir, 'HEAD', ['specs/x/spec.md'], { follow: true });
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`);
      }
      assert.equal(r.stamp.sha, written);
      // without follow the rename commit is the path's last touch
      const old = gitLogStamp(dir, 'HEAD', ['specs/x.md']);
      if (old.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(old)}`);
      }
      assert.equal(old.stamp.sha, renamed);
    });
  });

  test('a rename that also rewrites content stamps the move commit', () => {
    withRepo(dir => {
      commit(dir, 'spec', { 'specs/x.md': '# x\n' });
      mkdirSync(join(dir, 'specs', 'x'), { recursive: true });
      renameSync(join(dir, 'specs', 'x.md'), join(dir, 'specs', 'x', 'spec.md'));
      writeFileSync(join(dir, 'specs', 'x', 'spec.md'), '# x rewritten\n');
      const moved = commit(dir, 'move+edit spec', {});
      // below the -M100% similarity threshold the move reads as a
      // rewrite — the spec WAS touched, so the stamp is the commit
      const r = gitLogStamp(dir, 'HEAD', ['specs/x/spec.md'], { follow: true });
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`);
      }
      assert.equal(r.stamp.sha, moved);
    });
  });
});

describe('gitLogPathRecords', () => {
  test('per-commit records — sha, subject, touched paths', () => {
    withRepo(dir => {
      const sha = commit(dir, 'code (b1)', { 'src/a.ts': 'a\n' });
      const recs = gitLogPathRecords(dir, 'HEAD');
      assert.ok(recs !== null);
      const tip = recs.find(r => r.sha === sha);
      assert.ok(tip !== undefined);
      assert.equal(tip.subject, 'code (b1)');
      assert.ok(tip.paths.includes('src/a.ts'));
    });
  });

  test('a blown wall-clock bound is null — unverifiable, never a stall', {
    skip: process.platform === 'win32',
  }, () => {
    withRepo(dir => {
      // a PATH shim that sleeps makes the bound deterministic — real
      // git can finish under a 1ms timeout on a fast runner and flake
      const shim = mkdtempSync(join(tmpdir(), 'bro-git-shim-'));
      try {
        writeFileSync(join(shim, 'git'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
        const prev = process.env.PATH;
        process.env.PATH = `${shim}:${prev ?? ''}`;
        try {
          assert.equal(gitLogPathRecords(dir, 'HEAD', { timeoutMs: 1 }), null);
        } finally {
          if (prev === undefined) delete process.env.PATH;
          else process.env.PATH = prev;
        }
      } finally {
        rmSync(shim, { recursive: true, force: true });
      }
    });
  });

  test('null on a bad ref, never a throw', () => {
    withRepo(dir => {
      assert.equal(gitLogPathRecords(dir, 'nonexistent-ref'), null);
    });
  });
});

describe('repo env sanitization', () => {
  test('-C probes ignore an inherited GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR', () => {
    withRepo(dir => {
      const other = makeRepo();
      try {
        const touched = commit(dir, 'code', { 'src/a.ts': 'a\n' });
        const prev = { ...process.env };
        process.env.GIT_DIR = join(other, '.git');
        process.env.GIT_WORK_TREE = other;
        process.env.GIT_COMMON_DIR = join(other, '.git');
        try {
          const r = gitLogStamp(dir, 'HEAD', ['src/']);
          if (r.state !== 'commit') {
            assert.fail(`expected commit, got ${JSON.stringify(r)}`);
          }
          assert.equal(r.stamp.sha, touched);
          assert.equal(gitIsShallow(dir), false);
          assert.equal(gitDriftRef(dir), 'refs/heads/main');
        } finally {
          process.env = prev;
        }
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});

describe('gitIsAncestor', () => {
  test('true, false, and null for an unknown object', () => {
    withRepo(dir => {
      const first = git(dir, ['rev-parse', 'HEAD']);
      const second = commit(dir, 'two', { 'a.ts': 'a\n' });
      assert.equal(gitIsAncestor(dir, first, second), true);
      assert.equal(gitIsAncestor(dir, second, first), false);
      assert.equal(gitIsAncestor(dir, first, 'deadbeef'.repeat(5)), null);
    });
  });
});

describe('gitIsShallow', () => {
  test('false on a full repo, true on a depth-1 clone', () => {
    withRepo(dir => {
      assert.equal(gitIsShallow(dir), false);
      const clone = mkdtempSync(join(tmpdir(), 'bro-git-shallow-'));
      try {
        testGit(['clone', '-q', '--depth', '1', `file://${dir}`, join(clone, 'c')]);
        assert.equal(gitIsShallow(join(clone, 'c')), true);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });
  });
});

describe('gitUpstreamBehind', () => {
  test('positive drift reports the count and ref; current reads null', () => {
    withRepo(dir => {
      const remote = mkdtempSync(join(tmpdir(), 'bro-git-up-'));
      try {
        git(remote, ['init', '-q', '--bare', '-b', 'main']);
        git(dir, ['remote', 'add', 'origin', remote]);
        git(dir, ['push', '-qu', 'origin', 'main']);
        commit(dir, 'one', { 'a.ts': 'a\n' });
        commit(dir, 'two', { 'b.ts': 'b\n' });
        git(dir, ['push', '-q', 'origin', 'main']);
        git(dir, ['reset', '-q', '--hard', 'HEAD~2']);
        assert.deepEqual(gitUpstreamBehind(dir), { behind: 2, upstream: 'origin/main' });
        git(dir, ['reset', '-q', '--hard', 'origin/main']);
        assert.equal(gitUpstreamBehind(dir), null);
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  test('no upstream and detached HEAD read null, never an error', () => {
    withRepo(dir => {
      assert.equal(gitUpstreamBehind(dir), null);
      git(dir, ['checkout', '-q', '--detach', 'HEAD']);
      assert.equal(gitUpstreamBehind(dir), null);
    });
  });
});

describe('gitTryAsync', () => {
  test('a real git probe succeeds in a temporary repository', async () => {
    const dir = makeRepo();
    try {
      const result = await gitTryAsync(['-C', dir, 'rev-parse', '--show-toplevel']);
      assert.equal(result.code, 0);
      assert.equal(result.out.trim(), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('timeout kills a PATH-stubbed git process group and resolves promptly', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-git-timeout-'));
    const bin = join(root, 'bin');
    const stub = join(bin, 'git');
    const pidFile = join(root, 'pid');
    mkdirSync(bin);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$$" > "${pidFile}"\nexec sleep 30\n`, {
      mode: 0o755,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = [bin, previousPath].filter(Boolean).join(':');
    try {
      const started = Date.now();
      const result = await gitTryAsync(['--version'], 300);
      assert.ok(Date.now() - started < 1_500);
      assert.equal(result.code, 124);
      assert.equal(result.err, 'timed out after 300ms');
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      assert.ok(Number.isInteger(pid));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid)) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // already gone
            }
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('gitUpstreamBehindAsync reports a positive upstream drift', async () => {
  const dir = makeRepo();
  const remoteDir = mkdtempSync(join(tmpdir(), 'bro-git-up-async-'));
  const remoteWorktree = mkdtempSync(join(tmpdir(), 'bro-git-up-async-wt-'));
  try {
    git(remoteDir, ['init', '-q', '--bare', '-b', 'main']);
    git(dir, ['remote', 'add', 'origin', remoteDir]);
    git(dir, ['push', '-qu', 'origin', 'main']);
    assert.equal(await gitUpstreamBehindAsync(dir), null);
    git(remoteWorktree, ['clone', remoteDir, '.']);
    git(remoteWorktree, ['config', 'user.email', 't@t']);
    git(remoteWorktree, ['config', 'user.name', 't']);
    commit(remoteWorktree, 'one', { 'a.ts': 'a\n' });
    commit(remoteWorktree, 'two', { 'b.ts': 'b\n' });
    git(remoteWorktree, ['push', 'origin', 'main']);
    git(dir, ['fetch', 'origin']);
    assert.deepEqual(await gitUpstreamBehindAsync(dir), { behind: 2, upstream: 'origin/main' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(remoteWorktree, { recursive: true, force: true });
  }
});

describe('mainWorktreeRoot', () => {
  test('the main checkout resolves to itself, a subdirectory too', () => {
    withRepo(dir => {
      assert.equal(mainWorktreeRoot(dir), dir);
      mkdirSync(join(dir, 'deep', 'nest'), { recursive: true });
      assert.equal(mainWorktreeRoot(join(dir, 'deep', 'nest')), dir);
    });
  });

  test('a linked worktree resolves to the main checkout, not itself', () => {
    withRepo(dir => {
      const linked = mkdtempSync(join(tmpdir(), 'bro-git-linked-'));
      try {
        git(dir, ['worktree', 'add', '-q', linked, '-b', 'work/x']);
        assert.equal(mainWorktreeRoot(linked), dir);
        mkdirSync(join(linked, 'sub'), { recursive: true });
        assert.equal(mainWorktreeRoot(join(linked, 'sub')), dir);
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    });
  });

  test('a separate-git-dir main checkout resolves via its own toplevel', () => {
    // .git is a file here, not a dir — gitCommonDir's basename is not
    // '.git', so dirname(common) can't answer. Inside the main
    // worktree --git-dir === --git-common-dir, so --show-toplevel is
    // the root. (`worktree list` can't be: git records no path for a
    // moved gitdir's checkout and reports the common dir itself.)
    const root = mkdtempSync(join(tmpdir(), 'bro-git-sep-'));
    try {
      const gitdir = join(root, 'sepgit');
      const wt = join(root, 'checkout');
      git(root, ['init', '-q', '-b', 'main', '--separate-git-dir', gitdir, wt]);
      git(wt, ['config', 'user.email', 't@t']);
      git(wt, ['config', 'user.name', 't']);
      git(wt, ['commit', '-qm', 'init', '--allow-empty']);
      assert.equal(mainWorktreeRoot(wt), wt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a linked worktree of a separate-git-dir repo still finds the checkout', () => {
    // worktree list can't answer — git reports the moved gitdir itself
    // as the first record. The main checkout's `.git` FILE
    // (`gitdir: <common>`) is the only link: the sibling scan finds it.
    const root = mkdtempSync(join(tmpdir(), 'bro-git-seplink-'));
    const linked = mkdtempSync(join(tmpdir(), 'bro-git-sepw-'));
    try {
      const gitdir = join(root, 'sepgit');
      const wt = join(root, 'checkout');
      git(root, ['init', '-q', '-b', 'main', '--separate-git-dir', gitdir, wt]);
      git(wt, ['config', 'user.email', 't@t']);
      git(wt, ['config', 'user.name', 't']);
      git(wt, ['commit', '-qm', 'init', '--allow-empty']);
      git(wt, ['worktree', 'add', '-q', linked, '-b', 'work/sep']);
      assert.equal(mainWorktreeRoot(linked), wt);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  test('an external gitdir named `.git` does not fake the ordinary layout', () => {
    // --separate-git-dir can end in `.git` — basename alone would take
    // its parent as the checkout. Only a candidate whose own gitdir IS
    // the common dir passes the verify.
    const root = mkdtempSync(join(tmpdir(), 'bro-git-dotgit-'));
    try {
      const gitdir = join(root, '.git');
      const wt = join(root, 'wt', 'checkout');
      git(root, ['init', '-q', '-b', 'main', '--separate-git-dir', gitdir, wt]);
      git(wt, ['config', 'user.email', 't@t']);
      git(wt, ['config', 'user.name', 't']);
      git(wt, ['commit', '-qm', 'init', '--allow-empty']);
      assert.equal(mainWorktreeRoot(wt), wt);
      const linked = join(root, 'wt', 'linked');
      git(wt, ['worktree', 'add', '-q', linked, '-b', 'work/dotgit']);
      assert.equal(mainWorktreeRoot(linked), wt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a bare repo is no anchor — worktree list reports bare, answer is null', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-git-bare-'));
    const linked = mkdtempSync(join(tmpdir(), 'bro-git-barew-'));
    try {
      const bare = join(root, 'repo.git');
      git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
      git(bare, ['worktree', 'add', '-q', linked, '-b', 'work/bare']);
      // from the linked checkout: no main worktree exists, so null —
      // the caller keeps its own dir rather than anchoring to git storage
      assert.equal(mainWorktreeRoot(linked), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  test('outside a repository resolves null, never a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-norepo-'));
    try {
      assert.equal(mainWorktreeRoot(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitWorktreeRoots', () => {
  test('a solo repo lists just its own root', () => {
    withRepo(dir => {
      assert.deepEqual(gitWorktreeRoots(dir), [dir]);
    });
  });

  test('linked worktrees follow the main record', () => {
    withRepo(dir => {
      const linked = mkdtempSync(join(tmpdir(), 'bro-git-roots-'));
      try {
        git(dir, ['worktree', 'add', '-q', linked, '-b', 'work/roots']);
        assert.deepEqual(gitWorktreeRoots(dir), [dir, linked]);
        // from inside the linked checkout the set is the same
        assert.deepEqual(gitWorktreeRoots(linked), [dir, linked]);
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    });
  });

  test('a bare repo record is dropped, its linked worktrees kept', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-git-rootbare-'));
    const linked = mkdtempSync(join(tmpdir(), 'bro-git-rootbarew-'));
    try {
      const bare = join(root, 'repo.git');
      git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
      git(bare, ['worktree', 'add', '-q', linked, '-b', 'work/bare']);
      assert.deepEqual(gitWorktreeRoots(bare), [linked]);
      assert.deepEqual(gitWorktreeRoots(linked), [linked]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  test('outside a repository resolves empty, never a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-norepo-'));
    try {
      assert.deepEqual(gitWorktreeRoots(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unquoteGitPath', () => {
  test('octal escapes decode as UTF-8 bytes, not literal backslashes', () => {
    // git's C-quote encodes non-ASCII as \NNN octal bytes — JSON.parse
    // would reject the form, and a literal read leaves escapes in the
    // path (the pre-2.36 porcelain fallback hits this)
    assert.equal(unquoteGitPath('"f\\303\\244o"'), 'fäo');
    assert.equal(unquoteGitPath('"a\\342\\202\\254b"'), 'a€b');
  });

  test('named escapes and pass-through characters survive intact', () => {
    assert.equal(unquoteGitPath('"we\\\\ird\\"na\\tme"'), 'we\\ird"na\tme');
    assert.equal(unquoteGitPath('"plain/path"'), 'plain/path');
  });
});
