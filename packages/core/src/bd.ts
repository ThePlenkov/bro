/**
 * Thin `bd` (beads) wrapper — the single PATH/exec contract for every
 * package. PATH lookup is the contract (same as gh); a generous maxBuffer
 * keeps large `bd list --json` payloads from hitting Node's 1 MiB default.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

export function bd(args: string[], cwd?: string): string {
  return execFileSync('bd', args, { // NOSONAR — user-installed CLI; PATH lookup is the contract (same as gh)
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
  const proc = spawnSync('bd', args, { // NOSONAR — PATH lookup is the contract (same as gh/git)
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
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
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
const BD_NO_STORE = /no beads database|not initialized|no database found/i

function errText(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown }
  return `${typeof e?.message === 'string' ? e.message : String(err)}\n${
    typeof e?.stderr === 'string' ? e.stderr : ''
  }`
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
    res.missing = /ENOENT/.test(ver.err)
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
  // unclassifiable failure: once a probe proved the store reachable a
  // second one dying is suspicious enough to report — but when nothing
  // reached the store it's store state (corrupt db, perms), not drift
  if (res.store === 'reachable') {
    res.problems.push(`\`bd ${name}\` failed on a readable store — ${firstErrLine(p.err, p.code)}`)
    return true
  }
  res.store = 'error'
  res.storeErr = p.err
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
  const res: BdCompat = { ok: true, missing: false, problems: [], store: 'unprobed' }
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
  if (!compat.ok) {
    const v = compat.version ? ` ${compat.version}` : ''
    throw new BdCompatError(
      `bd${v} drifted off the contract bro speaks — ` + compat.problems.join('; ')
    )
  }
  if (compat.store !== 'reachable') {
    // preserve the real failure — "not initialized" is only one cause
    throw new Error(
      `bd list failed — ${compat.storeErr || 'no beads database found'} ` +
        '(run `bd init` if beads is not initialized here)'
    )
  }
}
