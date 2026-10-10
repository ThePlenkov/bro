/**
 * Rig lifecycle journal — one append-only JSONL per repo at
 * `<git-common>/bro/events.jsonl` (specs/telemetry/bro-ub91h.md). The
 * shared common dir makes one ordered file across linked worktrees;
 * the file lock serializes concurrent writers (loop/act/drive/agents/
 * work run as separate processes), so line position IS the sequence —
 * append order is the order.
 *
 * Row schema — small and stable:
 *   { ts, kind, bead?, pr?, actor, session, from?, to?, detail? }
 *
 * Writers call `emitLifecycle` AFTER the transition lands and never
 * hand-roll a journal line: a failed claim, refused merge, or errored
 * worktree add records nothing. Fail-open throughout — a null git
 * dir, an unwritable file, or a lock timeout degrades to a best-effort
 * append or a no-op; telemetry must never throw into the command it
 * observes. Self-capping like act-checks.jsonl (the janitor's own
 * "self-caps" rule): past the byte bound the file truncates to its
 * newest whole lines.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitCommonDir } from './git.ts'
import { withFileLock } from './filelock.ts'
import { bdActor } from './tasks.ts'

/** The transition verbs the lifecycle covers (specs/telemetry/
 *  bro-ub91h.md). A closed union for writers — readers treat `kind` as
 *  an open string so a future kind never breaks the plane. */
export const LIFECYCLE_KINDS = [
  'claim',
  'worktree',
  'spawn',
  'agent-exit',
  'pr-open',
  'gate',
  'verdict',
  'merge',
  'park',
  'release',
  'close',
] as const
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number]

/** One stored journal row. `actor`/`session` are required on disk —
 *  the emitter derives them when the writer doesn't say. */
export interface LifecycleEvent {
  /** ISO-8601 transition time — the emitter's clock, or the caller's
   *  honest stamp (an .exit file's mtime beats the harvest time). */
  ts: string
  kind: LifecycleKind
  /** The bead the transition binds to — lead of a clump; the full
   *  member list can ride `detail.beads`. */
  bead?: string
  pr?: number
  /** The doer — a worker's BRO_AGENT_ID, else the bd claim actor. */
  actor: string
  /** The session env chain (same as `bro goal`), else 'shell'. */
  session: string
  /** State edge — `open`→`in_progress`, `running`→`exited`, →`merged`. */
  from?: string
  to?: string
  /** Flat JSON extras — agent, code, cause, round, sha, blockers,
   *  worktree, branch, via (the writing surface). */
  detail?: Record<string, unknown>
}

/** What a writer passes — the emitter stamps `ts` and derives
 *  `actor`/`session` from env + the store's actor chain. */
export interface LifecycleInput {
  kind: LifecycleKind
  bead?: string
  pr?: number
  actor?: string
  session?: string
  from?: string
  to?: string
  detail?: Record<string, unknown>
  /** Honest transition time — ISO string or epoch ms. */
  ts?: string | number
}

/** 4 MiB of lifecycle history ≈ months of a busy rig — the derived
 *  views are windowed anyway; a wedged writer must not grow the file
 *  forever. Truncation keeps the newest whole lines under 2 MiB. */
const LIFECYCLE_MAX_BYTES = 4 * 1024 * 1024
const LIFECYCLE_KEEP_BYTES = 2 * 1024 * 1024

/** `<git-common>/bro/events.jsonl` — null outside a repo; shared
 *  across linked worktrees the same way the sibling journals are. */
export function lifecyclePath(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'events.jsonl')
}

/** The session env chain — a spawned worker's BRO_SESSION_ID pins its
 *  agentId; an interactive session carries its host's id; anything
 *  else resolves undefined and the row records 'shell'. */
const SESSION_ENV = [
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const

function sessionEnv(): string | undefined {
  for (const k of SESSION_ENV) {
    const v = process.env[k]?.trim()
    if (v !== undefined && v !== '') {
      return v
    }
  }
  return undefined
}

/** Truncate to the newest whole lines once the file outgrows the cap —
 *  tmp+rename so a reader never sees a half-written journal. Runs
 *  inside the append lock so a concurrent writer can't lose its row. */
function compactLifecycle(file: string): void {
  try {
    if (statSync(file).size <= LIFECYCLE_MAX_BYTES) {
      return
    }
    const raw = readFileSync(file, 'utf8')
    const tail = raw.slice(raw.length - LIFECYCLE_KEEP_BYTES)
    const cut = tail.indexOf('\n')
    writeFileSync(`${file}.tmp`, cut >= 0 ? tail.slice(cut + 1) : tail)
    renameSync(`${file}.tmp`, file)
  } catch {
    // compaction is housekeeping — a failure never blocks the record
  }
}

/** Append one lifecycle row — the ONLY writer every surface shares.
 *  Stamps ts, derives actor (BRO_AGENT_ID → bdActor) and session (env
 *  chain → 'shell'), then appends + caps under the file's lock. A lock
 *  timeout degrades to the plain append, never a stall; anything worse
 *  is a no-op. */
export function emitLifecycle(dir: string, input: LifecycleInput): void {
  try {
    const file = lifecyclePath(dir)
    if (file === null) {
      return
    }
    const badge = process.env.BRO_AGENT_ID?.trim()
    const actor = input.actor ?? (badge !== undefined && badge !== '' ? badge : bdActor(dir))
    const session = input.session ?? sessionEnv() ?? 'shell'
    const ts =
      input.ts === undefined
        ? new Date().toISOString()
        : typeof input.ts === 'number'
          ? new Date(input.ts).toISOString()
          : input.ts
    const row: LifecycleEvent = {
      ts,
      kind: input.kind,
      ...(input.bead !== undefined ? { bead: input.bead } : {}),
      ...(input.pr !== undefined ? { pr: input.pr } : {}),
      actor,
      session,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    }
    const line = `${JSON.stringify(row)}\n`
    const append = (): void => {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line)
      compactLifecycle(file)
    }
    try {
      withFileLock(`${file}.lock`, append, { waitMs: 2_000, label: 'lifecycle journal' })
    } catch {
      append()
    }
  } catch {
    // telemetry never throws into the transition it observes
  }
}

/** A lifecycle row as read — `kind` stays an open string on the read
 *  side so a journal carrying newer kinds still parses. */
export interface LifecycleRead extends Omit<LifecycleEvent, 'kind'> {
  kind: string
  /** 1-based line position in the current file — the append-order
   *  sequence; compaction resets it (a plane read reports `gapped`). */
  seq: number
}

function isLifecycleRow(v: unknown): v is LifecycleEvent {
  const o = v as Partial<LifecycleEvent>
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.ts === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.actor === 'string' &&
    typeof o.session === 'string' &&
    (o.bead === undefined || typeof o.bead === 'string') &&
    (o.pr === undefined || typeof o.pr === 'number') &&
    (o.from === undefined || typeof o.from === 'string') &&
    (o.to === undefined || typeof o.to === 'string')
  )
}

/** Ordered read of the journal — file order, torn/malformed lines
 *  skipped not fatal (a crash mid-append is a torn tail). `limit`
 *  returns the NEWEST rows; `since` keeps rows with ts > since
 *  (ISO-compare — all rows are UTC stamps). */
export function readLifecycle(
  dir: string,
  opts: { limit?: number; kind?: string; bead?: string; pr?: number; since?: string } = {}
): LifecycleRead[] {
  const file = lifecyclePath(dir)
  if (file === null) {
    return []
  }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: LifecycleRead[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line === '') {
      continue
    }
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isLifecycleRow(row)) {
      continue
    }
    const ev = { ...row, seq: i + 1 }
    if (opts.kind !== undefined && ev.kind !== opts.kind) {
      continue
    }
    if (opts.bead !== undefined && ev.bead !== opts.bead) {
      continue
    }
    if (opts.pr !== undefined && ev.pr !== opts.pr) {
      continue
    }
    if (opts.since !== undefined && ev.ts <= opts.since) {
      continue
    }
    out.push(ev)
  }
  return opts.limit !== undefined && out.length > opts.limit ? out.slice(-opts.limit) : out
}
