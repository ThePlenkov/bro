/**
 * Thin `bd` (beads) wrapper — the single PATH/exec contract for every
 * package. PATH lookup is the contract (same as gh); a generous maxBuffer
 * keeps large `bd list --json` payloads from hitting Node's 1 MiB default.
 */
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { spawnCollect } from './live-procs.ts'
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** `timeout` supervises every bd call — the caller's own deadline dies
 *  with the caller, and an orphaned bd waits on the embedded noms LOCK
 *  forever, wedging the store for every later invocation (bro-8845g,
 *  drill bro-wisp-fk8). The supervisor reparents with its child and
 *  still fires at the backstop. `--foreground` keeps bd in timeout's
 *  process group so a group kill — ours or an external supervisor's —
 *  reaches both. No GNU timeout → bare bd: same contract, the orphan
 *  risk comes back but nothing else changes. */
// PATH-keyed: a process that swaps PATH mid-life (tests injecting a
// fake timeout, env sanitizers) must re-probe, not ride a stale verdict
let timeoutProbe: { path?: string; bin: string | null } | undefined
function supervised(args: string[], timeoutMs: number): { cmd: string; argv: string[] } {
  const path = process.env.PATH
  if (timeoutProbe === undefined || timeoutProbe.path !== path) {
    let bin: string | null = null
    for (const candidate of ['timeout', 'gtimeout']) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' })
        bin = candidate
        break
      } catch { /* absent or non-GNU — fall through to bare bd */ }
    }
    timeoutProbe = { path, bin }
  }
  if (timeoutProbe.bin === null) {
    return { cmd: 'bd', argv: args }
  }
  // caller budget + margin — the backstop only matters when the caller
  // died before its own timeout could kill the child
  const backstopSec = Math.ceil((timeoutMs + 30_000) / 1000)
  return {
    cmd: timeoutProbe.bin,
    argv: ['--foreground', '-k', '5s', `${backstopSec}s`, 'bd', ...args],
  }
}

/** A missing `bd` reads "ENOENT" on a bare spawn but
 *  "failed to run command 'bd': No such file or directory" under the
 *  timeout supervisor — normalize so every consumer's ENOENT check
 *  (probeVersion, the store doctype's install-beads diagnostic, …)
 *  classifies the setup gap identically either way. */
function normalizeSpawnErr(err: string): string {
  // GNU timeout: "failed to run command 'bd': No such file or directory"
  // — under a UTF-8 locale gnulib quote() emits U+2018/U+2019 around the
  // name ('bd'), so the match must not pin the quote marks; uutils:
  // "failed to execute process: No such file or directory (os error 2)".
  // The errno text is required — an EACCES miss prints "Permission
  // denied" and must stay unnormalized (broken, not missing).
  return /failed to (run command|execute process)[^\n]*no such file or directory/i.test(err)
    ? `ENOENT ${err}`
    : err
}

/** Kill the whole supervised group — the async spawns run `detached`
 *  so -pid reaches `timeout` and `bd` together; a bare-bd spawn still
 *  leads its own one-member group. Direct-child kill is the fallback. */
function killGroup(proc: ChildProcess): void {
  const pid = proc.pid
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch { /* group already gone */ }
  }
  try {
    proc.kill('SIGKILL')
  } catch { /* already dead */ }
}

export function bd(args: string[], cwd?: string): string {
  const s = supervised(args, 15_000)
  return execFileSync(s.cmd, s.argv, { // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
    encoding: 'utf8',
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    // pipe stderr — *Sync variants inherit it by default, and bd chatters
    // ("no beads database found") into hook logs on every probe. Real
    // errors still surface on err.stderr for callers that catch.
    stdio: ['ignore', 'pipe', 'pipe'],
    // a wedged bd must degrade, not stall — hooks call this inline in the
    // agent lifecycle
    timeout: 15_000,
  })
}

/** Non-throwing bd — same contract as gitTry for paths where beads is
 *  optional (merge slot, hooks): a missing binary or absent database must
 *  degrade, not stall. */
export function bdTry(
  args: string[],
  timeoutMs = 15_000,
  /** Run bd against another store dir — the global queue lives outside
   *  the project checkout, so callers pass it explicitly. */
  cwd?: string
): { code: number; out: string; err: string } {
  const s = supervised(args, timeoutMs)
  const proc = spawnSync(s.cmd, s.argv, { // NOSONAR — PATH lookup is the contract (same as gh/git)
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    // same maxBuffer contract as bd() — a future caller passing a large
    // payload must not silently get truncated stdout
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: normalizeSpawnErr((proc.stderr ?? proc.error?.message ?? '').trim()),
  }
}

export function bdJson<T>(args: string[], cwd?: string): T {
  const out = bd([...args, '--json'], cwd)
  try {
    return JSON.parse(out) as T
  } catch (err) {
    throw new Error(
      `bd returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** bd against a SPECIFIC store — BEADS_DIR pins the shared dolt so a
 *  connector claims where the spec says, not wherever cwd happens to
 *  resolve. Same PATH-lookup contract as the rest of this file. The
 *  `ran` flag lets callers tell a real exit (conflict) from a spawn
 *  failure/timeout/signal (unavailable). */
export function bdAt(
  beadsDir: string,
  args: string[],
  timeoutMs = 15_000
): { code: number; out: string; err: string; ran: boolean } {
  const proc = spawnSync('bd', args, { // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    env: { ...process.env, BEADS_DIR: beadsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (
      proc.stderr ||
      proc.error?.message ||
      (proc.signal !== null ? `killed by ${proc.signal}` : '')
    ).trim(),
    ran: proc.error === undefined && proc.status !== null,
  }
}

// --- async variants ------------------------------------------------------------

/** Async `bd` — the probe-path contract. `spawnSync` inside a hook
 *  probe blocks the whole event loop: with N serial probes each bd call
 *  (~1.3s of dolt startup) stacks into the observed 30s session-start.
 *  The async form lets connector sweeps overlap their bd calls, so the
 *  hook costs one bd latency, not the sum. Rejects carry the
 *  execFileSync-style shape (`.code/.stdout/.stderr`) so isBdNotFound
 *  and friends classify async failures exactly like sync ones. */
export function bdAsync(args: string[], cwd?: string): Promise<string> {
  const s = supervised(args, 15_000)
  const { proc, done } = spawnCollect(s.cmd, s.argv, cwd, undefined, { detached: true })
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(proc)
    }, 15_000)
    timer.unref?.()
    void done.then(({ code, out, err, error }) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(
          Object.assign(new Error(`bd ${args[0] ?? ''} timed out after 15000ms`), {
            code: 'ETIMEDOUT',
            stdout: out,
            stderr: err,
            killed: true,
          })
        )
        return
      }
      if (error !== undefined) {
        reject(Object.assign(error, { stdout: out, stderr: normalizeSpawnErr(err) }))
        return
      }
      if (code === 0) {
        resolve(out)
        return
      }
      const errMsg = normalizeSpawnErr(err)
      reject(
        Object.assign(new Error(`bd ${args.join(' ')} failed (${code ?? 1}): ${errMsg}`), {
          code: code ?? 1,
          stdout: out,
          stderr: errMsg,
        })
      )
    })
  })
}

/** Non-throwing async bd — the spawnSync bdTry's twin for probe paths
 *  where beads is optional and must degrade, never stall. */
export function bdTryAsync(
  args: string[],
  timeoutMs = 15_000,
  cwd?: string
): Promise<{ code: number; out: string; err: string }> {
  const s = supervised(args, timeoutMs)
  const { proc, done } = spawnCollect(s.cmd, s.argv, cwd, undefined, { detached: true })
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(proc)
    }, timeoutMs)
    timer.unref?.()
    void done.then((r) => {
      clearTimeout(timer)
      resolve(
        timedOut
          ? { code: 124, out: r.out, err: `timed out after ${timeoutMs}ms` }
          : { code: r.code ?? 1, out: r.out, err: normalizeSpawnErr(r.err) }
      )
    })
  })
}

export async function bdJsonAsync<T>(args: string[], cwd?: string): Promise<T> {
  const out = await bdAsync([...args, '--json'], cwd)
  try {
    return JSON.parse(out) as T
  } catch (err) {
    throw new Error(
      `bd returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Thrown when the bd binary can't speak the contract bro assumes — a
 * renamed/removed command or flag, or a `--json` payload in a different
 * shape. Distinct from operational failures (no binary, no store, a
 * corrupt db): compat is permanent until bd is upgraded or downgraded,
 * so callers may degrade — warn and fall back — instead of retrying.
 */
export class BdCompatError extends Error {
  override name = 'BdCompatError'
}

/** stderr/message patterns that mean the bd binary rejected the call —
 *  renamed/removed commands or flags. Store-state errors (`no beads
 *  database`) are deliberately absent: that's an environment problem,
 *  not API drift. */
const BD_USAGE_DRIFT =
  /unknown (command|flag|shorthand)|flag provided but not defined|unrecognized command/i
/** "the binary ran but there's no store it routes to" — distinguishes a
 *  missing/unrouted store (a 503, never a refused op) from a real
 *  command-level failure. Exported for the sync + claim classifiers. */
export const BD_NO_STORE = /no beads database|not initialized|no database found/i

function errText(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown }
  return `${typeof e?.message === 'string' ? e.message : String(err)}\n${
    typeof e?.stderr === 'string' ? e.stderr : ''
  }`
}

/** bd's exact lookup-miss signals — `bd show <id>` on an absent row
 *  prints `Issue <id> not found` on stderr and a
 *  `no issues found matching the provided IDs` error payload on
 *  stdout. Only these mark a miss — anything else containing "not
 *  found" (a malformed payload, a dead store) must stay thrown. */
const BD_NOT_FOUND = /Issue .+ not found|no issues found matching the provided IDs/i

/** Classifier for a thrown bd error: true when the backend reported the
 *  requested id absent. Scans stderr *and* stdout — bd writes the
 *  miss's JSON error object to stdout. */
export function isBdNotFound(err: unknown): boolean {
  const out = (err as { stdout?: unknown } | null | undefined)?.stdout
  return BD_NOT_FOUND.test(`${errText(err)}\n${typeof out === 'string' ? out : ''}`)
}

/** Classifier for errors thrown out of any bd call: contract drift vs
 *  operational failure. Drives the degrade decision — drift is permanent
 *  until bd changes, so callers may warn + fall back rather than fail. */
export function isBdCompatError(err: unknown): boolean {
  if (err instanceof BdCompatError) {
    return true
  }
  const t = errText(err)
  return BD_USAGE_DRIFT.test(t) || t.includes('malformed JSON')
}

export interface BdCompat {
  /** no drift found — bd speaks the contract bro assumes */
  ok: boolean
  /** bd binary absent (ENOENT) — a setup gap, not drift */
  missing: boolean
  /** bd present but `bd --version` itself failed — operational
   *  (timeout, permissions), not drift; do not degrade on it */
  broken: boolean
  version?: string
  /** drift findings — non-empty ⇒ ok:false */
  problems: string[]
  /** what the read probes saw. 'absent' = no store to probe, so shape
   *  checks were inconclusive; 'error' = a store failure that isn't
   *  classifiable as drift (corrupt db, permissions) */
  store: 'reachable' | 'absent' | 'error' | 'unprobed'
  storeErr?: string
}

/** The newest `.beads` schema_version this bro was built against —
 *  `bd info --json` reports it; a newer value means the store moved
 *  past what this code reads. */
export const BD_KNOWN_SCHEMA_VERSION = 1

function rowShape(v: unknown, cmd: string, problems: string[]): void {
  if (!Array.isArray(v)) {
    problems.push(
      `\`bd ${cmd} --json\` returned ${v === null ? 'null' : typeof v}, expected an array`
    )
    return
  }
  for (const r of v) {
    if (typeof r !== 'object' || r === null || typeof (r as { id?: unknown }).id !== 'string') {
      problems.push(`\`bd ${cmd} --json\` rows lack a string \`id\` — output shape drifted`)
      return
    }
  }
}

function firstErrLine(err: string, code: number): string {
  return err.split('\n')[0] || `exit ${code}`
}

/** Presence probe — false aborts the compat run (nothing else answers
 *  without the binary). */
function probeVersion(res: BdCompat, dir?: string): boolean {
  const ver = bdTry(['--version'], 10_000, dir)
  if (ver.code !== 0) {
    // bare spawn reports ENOENT; under `timeout` the same miss is
    // normalized by bdTry to ENOENT too — one check covers both
    res.missing = /ENOENT/.test(ver.err)
    res.broken = !res.missing
    res.problems.push(
      res.missing ? 'bd not found on PATH' : `\`bd --version\` failed — ${ver.err || 'spawn error'}`
    )
    res.ok = false
    return false
  }
  res.version = /\d+\.\d+[\d.]*/.exec(`${ver.out} ${ver.err}`)?.[0]?.replace(/\.*$/, '')
  return true
}

/** One read-path probe: `bd <name> --json -n 1` must answer a JSON array
 *  of id-keyed rows while a store is reachable. Records the store state
 *  the first probe observes; usage errors are drift anywhere. */
function probeRead(res: BdCompat, name: string, dir?: string): boolean {
  const p = bdTry([name, '--json', '-n', '1'], 15_000, dir)
  if (p.code === 0) {
    res.store = 'reachable'
    try {
      rowShape(JSON.parse(p.out), name, res.problems)
    } catch {
      res.problems.push(`\`bd ${name} --json\` returned non-JSON output`)
    }
    return true
  }
  if (BD_USAGE_DRIFT.test(p.err)) {
    res.problems.push(`\`bd ${name}\` rejected the call — ${firstErrLine(p.err, p.code)}`)
    return true
  }
  if (BD_NO_STORE.test(p.err)) {
    res.store = 'absent'
    res.storeErr = p.err
    return false // every remaining probe hits the same wall
  }
  // unclassifiable failure is store state (corrupt db, lock, perms),
  // not proof of drift — degrade is for contract breakage only
  res.store = 'error'
  res.storeErr = `\`bd ${name}\` failed — ${firstErrLine(p.err, p.code)}`
  return false
}

/** Schema probe — meaningful only with a live store. */
function probeSchema(res: BdCompat, dir?: string): void {
  const info = bdTry(['info', '--json'], 15_000, dir)
  if (info.code !== 0) {
    // usage errors = drift; anything else is operational, not compat
    if (BD_USAGE_DRIFT.test(info.err)) {
      res.problems.push(`\`bd info\` rejected the call — ${firstErrLine(info.err, info.code)}`)
    }
    return
  }
  try {
    const parsed = JSON.parse(info.out) as { schema_version?: unknown }
    const v = parsed.schema_version
    if (typeof v === 'number' && v > BD_KNOWN_SCHEMA_VERSION) {
      res.problems.push(
        `bd store schema_version ${v} is newer than bro knows (${BD_KNOWN_SCHEMA_VERSION})`
      )
    }
  } catch {
    res.problems.push('`bd info --json` returned non-JSON output')
  }
}

/**
 * Compat probe — verifies the bd contract bro relies on, since version
 * numbers can't pin a pre-1.0 CLI. Read-path probes run only while a
 * store is reachable; without one, flag/command drift still surfaces
 * (usage errors precede the database check) but output shape stays
 * unproven.
 */
export function probeBdCompat(dir?: string): BdCompat {
  const res: BdCompat = { ok: true, missing: false, broken: false, problems: [], store: 'unprobed' }
  if (!probeVersion(res, dir)) {
    return res
  }
  // The read path every TaskStore consumer builds on: list + ready.
  for (const name of ['list', 'ready']) {
    if (!probeRead(res, name, dir)) {
      break
    }
  }
  if (res.store === 'reachable') {
    probeSchema(res, dir)
  }
  res.ok = res.problems.length === 0
  return res
}

/** Classify a provenance ref — shared by drill and retro evidence. */
export function refKind(ref: string): string {
  if (/\/pull\/|\/merge_requests\//.test(ref)) {
    return 'pr'
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return 'git-sha'
  }
  return 'work-id'
}

/** Provenance event kind for an evidence ref — a work-id is not a commit. */
export function evidenceKind(ref: string): 'land' | 'commit' | 'used' {
  switch (refKind(ref)) {
    case 'pr':
      return 'land'
    case 'git-sha':
      return 'commit'
    default:
      return 'used'
  }
}

/** Only a real `.beads` *directory* counts — a file or dangling path must
 *  not suppress init (it would fail loudly rather than be repaired). */
function beadsDirExists(): boolean {
  try {
    return statSync(join(process.cwd(), '.beads')).isDirectory()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw err // EACCES/ELOOP etc. are real failures — don't mask as "absent"
  }
}

/**
 * Stealth-init `.beads` in the current repo when missing — the single init
 * flags contract shared by debt sync and `bro setup` (local exclude,
 * nothing lands in git). Returns true when it initialized.
 */
export function initBeadsStealth(): boolean {
  if (beadsDirExists()) {
    return false
  }
  try {
    bd(['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'])
    return true
  } catch (err) {
    // Two first-time inits can race: both pass the existence check, the
    // loser's `bd init` fails while the winner's workspace lands. Tolerate
    // that race — callers verify completeness (`bd list` in checkBeads) —
    // but never swallow a real init failure.
    if (beadsDirExists()) {
      return false
    }
    throw err
  }
}

export function checkBeads(dir?: string): void {
  const compat = probeBdCompat(dir)
  if (compat.missing) {
    throw new Error('bd not found — install beads first (https://github.com/gastownhall/beads)')
  }
  if (compat.broken) {
    throw new Error(`bd unusable — ${compat.problems.join('; ')}`)
  }
  if (!compat.ok) {
    const v = compat.version ? ` ${compat.version}` : ''
    throw new BdCompatError(
      `bd${v} drifted off the contract bro speaks — ` + compat.problems.join('; ')
    )
  }
  if (compat.store !== 'reachable') {
    // preserve the real failure — "not initialized" is only one cause
    throw new Error(
      compat.store === 'error'
        ? `bd store probe failed — ${compat.storeErr}`
        : `bd list failed — ${compat.storeErr || 'no beads database found'} ` +
            '(run `bd init` if beads is not initialized here)'
    )
  }
}
