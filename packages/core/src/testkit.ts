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
  return execFileSync('git', args, {
    ...opts,
    env: testGitEnv(opts.env ?? process.env),
    encoding: 'utf8',
  }) // NOSONAR — PATH lookup is the contract (same as core/git.ts)
}

/** spawnSync('git') under the same contract — for call sites that need
 *  the exit status instead of a throw. */
export function testGitSpawn(
  args: string[],
  opts: SpawnSyncOptions = {}
): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    ...opts,
    env: testGitEnv(opts.env ?? process.env),
    encoding: 'utf8',
  }) // NOSONAR — PATH lookup is the contract (same as core/git.ts)
}

/** Delete ambient repo/agent pins from process.env (git-location and
 *  GIT_CONFIG* vars, BEADS_DIR, BRO_*, plus caller-named extras) and
 *  return a restore() for an `after` hook. A suite whose code-under-
 *  test spawns git or resolves the store in-process inherits pins that
 *  redirect those lookups into the OUTER repo — same leak testGit
 *  closes for the test's own spawns. The null-config pins are set too
 *  so in-process git children can't read host hooks/config either. */
export function scrubEnv(extra: string[] = []): () => void {
  const ambient = /^(BEADS_DIR|BRO_)/
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) {
    if (AMBIENT_GIT.test(k) || ambient.test(k) || extra.includes(k)) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }
  // a var that matched AMBIENT_GIT is only in saved when it was set —
  // record the pins too or they'd leak past the restore
  for (const k of ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL']) {
    if (!(k in saved)) saved[k] = process.env[k]
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = devNull
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}
