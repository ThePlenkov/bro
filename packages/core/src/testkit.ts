/** Test seam — scrubbed git spawns and the ambient-env guard shared by
 *  every package's fixture suites (same role as providers' testkit).
 *  A raw execFileSync('git') inside a test run inherits the OUTER
 *  session's repo-location pins (GIT_DIR/GIT_WORK_TREE/…) and config
 *  injection (GIT_CONFIG_*, host ~/.gitconfig core.hooksPath,
 *  commit.gpgsign, init.defaultBranch) — a pinned hooksPath runs host
 *  hooks on fixture commits. Fixture git goes through testGit /
 *  testGitSpawn; suites whose code-under-test spawns git in-process
 *  arm `after(scrubEnv())` once at file scope. */
import { execFileSync, spawnSync } from 'node:child_process'
import type { ExecFileSyncOptions, SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
import { devNull } from 'node:os'
import { tmpDir } from './testtmp.ts'

/** Ambient env that must not reach a fixture's git children. The
 *  repo-location pins retarget the child outright; the GIT_CONFIG*
 *  family (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS)
 *  injects config — a pinned core.hooksPath would run host hooks on
 *  fixture commits — and GIT_TEMPLATE_DIR plants hook files at init.
 *  GIT_AUTHOR_ and GIT_COMMITTER_ pins are deliberately absent:
 *  fixtures set commit dates through them. */
export const AMBIENT_GIT =
  /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_CONFIG($|_)|GIT_TEMPLATE_DIR$)/

/** Scrubbed env for a fixture git child — ambient vars out, global and
 *  system config pinned to null so a host gitconfig can't leak the same
 *  hooks/signing/branch config in through a file instead of a var. A
 *  caller-supplied env keeps its whitelist shape — the scrub and the
 *  pins apply on top of it, so a passed env can never re-open the hole. */
export function testGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(([k]) => !AMBIENT_GIT.test(k))
  ) as NodeJS.ProcessEnv
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = devNull
  return env
}

/** execFileSync('git') under the fixture-env contract — same options
 *  surface (encoding forced utf8), with the ambient strip and the
 *  null-config pins applied to whatever env the site passes. */
export function testGit(args: string[], opts: ExecFileSyncOptions = {}): string {
  // codeql[js/second-order-command-line-injection] — test seam: args are fixture literals, never user input
  return execFileSync('git', args, { // NOSONAR — PATH lookup is the contract (same as core/git.ts)
    ...opts,
    env: testGitEnv(opts.env ?? process.env),
    encoding: 'utf8',
  })
}

/** A fixture repo shaped like a real one on ANY host git. `init` alone
 *  leaves HEAD unborn, and `worktree add -b` / `merge-base` against an
 *  unborn head is a host-version dice-roll — the first commit makes the
 *  repo complete. Identity rides as env vars and signing-off as a -c
 *  pin, never a config file: a host ~/.gitconfig the env pins nulled
 *  can't leak identity or gpgsign into the fixture in either direction. */
export function testRepoInit(dir: string, branch = 'main'): void {
  testGit(['init', '-q', '-b', branch, dir])
  // identity as env, not -c: GIT_AUTHOR_*/GIT_COMMITTER_* outrank
  // -c user.* and the ambient strip keeps them (fixtures set commit
  // dates through them) — pin all four or a host-exported ident wins
  testGit(
    ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init', '--allow-empty'],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }
  )
}

/** spawnSync('git') under the same contract — for call sites that need
 *  the exit status instead of a throw. */
export function testGitSpawn(
  args: string[],
  opts: SpawnSyncOptions = {}
): SpawnSyncReturns<string> {
  // codeql[js/second-order-command-line-injection] — test seam: args are fixture literals, never user input
  return spawnSync('git', args, { // NOSONAR — PATH lookup is the contract (same as core/git.ts)
    ...opts,
    env: testGitEnv(opts.env ?? process.env),
    encoding: 'utf8',
  })
}

/** Delete ambient repo/agent pins from process.env (git-location and
 *  GIT_CONFIG* vars, BEADS_DIR, BRO_*, plus caller-named extras) and
 *  return a restore() for an `after` hook. A suite whose code-under-
 *  test spawns git or resolves the store in-process inherits pins that
 *  redirect those lookups into the OUTER repo — same leak testGit
 *  closes for the test's own spawns. The null-config pins are set too
 *  so in-process git children can't read host hooks/config either.
 *  Sets `XDG_CONFIG_HOME` to an empty temp dir so host `~/.config/bro`
 *  can't leak in, and sets `BRO_TEST=1` and `BRO_NO_GLOBAL_CONFIG=1`. */
export function scrubEnv(extra: string[] = []): () => void {
  const ambient = /^(BEADS_DIR|BRO_)/
  const scrubbed = (k: string) =>
    AMBIENT_GIT.test(k) || ambient.test(k) || extra.includes(k) || k === 'XDG_CONFIG_HOME'
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) {
    if (scrubbed(k)) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }
  // record absent extras and the pin keys as undefined too — a var the
  // code-under-test sets during the scrub window must not leak past
  // the restore
  for (const k of [...extra, 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME']) {
    if (!(k in saved)) saved[k] = process.env[k]
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = devNull
  // Point global config to an empty temp dir so host ~/.config/bro can't leak in
  const dir = tmpDir('bro-xdg-')
  process.env.XDG_CONFIG_HOME = dir
  process.env.BRO_TEST = '1'
  process.env.BRO_NO_GLOBAL_CONFIG = '1'
  if (!('XDG_CONFIG_HOME' in saved)) {
    saved['XDG_CONFIG_HOME'] = undefined
  }
  return () => {
    // the pattern classes are unbounded — rescan so a pin re-added
    // mid-window dies here instead of leaking into the next suite
    for (const k of Object.keys(process.env)) {
      if (scrubbed(k) && !(k in saved)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    if (!('BRO_TEST' in saved)) delete process.env.BRO_TEST
    if (!('BRO_NO_GLOBAL_CONFIG' in saved)) delete process.env.BRO_NO_GLOBAL_CONFIG
  }
}

/** The noms manifest line for a fixture dolt store — v5 layout
 *  `5:__DOLT__:<lock>:<root>:<extra>:` then name:count pairs (spec:
 *  specs/bro-orcdv.md). */
export function doltManifest(tables: Record<string, number> = {}): string {
  const pairs = Object.entries(tables).flatMap(([n, c]) => [n, String(c)])
  return `${['5', '__DOLT__', '0'.repeat(32), '1'.repeat(32), '0'.repeat(32), ...pairs].join(':')}\n`
}

/** Commit `files` into `dir`'s repo (bare or not) as the next
 *  `refs/dolt/data` head — pure plumbing, no worktree needed. `parent`
 *  chains history for last-good walks. Returns the head sha. */
export function doltStoreCommit(
  dir: string,
  files: Record<string, string>,
  parent?: string
): string {
  const blob = (content: string): string =>
    testGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim()
  const entries = Object.entries(files)
    .map(([name, c]) => `100644 blob ${blob(c)}\t${name}\0`)
    .join('')
  const tree = testGit(['-C', dir, 'mktree', '-z'], { input: entries }).trim()
  const head = testGit(
    [
      '-C', dir,
      '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit-tree', tree,
      ...(parent === undefined ? [] : ['-p', parent]),
      '-m', 'store',
    ]
  ).trim()
  testGit(['-C', dir, 'update-ref', 'refs/dolt/data', head])
  return head
}
