/**
 * `bro watch` — the deterministic orchestrator heartbeat: one snapshot of
 * every read plane a supervisor glues together by hand today — open
 * molecules (nextStep), act exit gates for fleet PRs, and the fleet
 * itself. Spec: specs/sessions/bro-f4ot/bro-vf1j.md.
 *
 *   bro watch [--once]      one snapshot (default — the heartbeat call)
 *   bro watch --every N     tick the snapshot every N seconds
 *   bro watch --notify      drop each tick's snapshot into the mailbox
 *   bro watch --json        machine-readable {ts, attention, mols, gates, fleet}
 *
 * `--every` exists so watch *can* loop, but the cadence owner is the
 * deployment — a supervisor that wants ticks on a schedule re-invokes
 * `--once`. Read-only: never claims, never mutates beads, never touches
 * the registry — the only write is `--notify`'s mailbox drop.
 *
 * Mailbox — `<git-common-dir>/bro/notify/`, the contract the notify
 * connector (bro-d8zo) drains. One atomic file per emission
 * (`watch-<epoch_ms>-<rand>.txt`, tmp+rename). In `--every` mode an
 * unchanged snapshot is not re-emitted — a heartbeat reports
 * transitions, not noise.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitTry, reviewHost, type ReviewFacade } from '@broject/core'
import { evaluateExitGate, fetchPrActState } from '@broject/act'
import { listMolecules, loadMolecule, nextStep } from '@broject/convoy'
import { loadBroConfig } from '../plugins.ts'
import { flag } from './args.ts'
import {
  collectAgents,
  fleetRows,
  fleetTableLines,
  type FleetRow,
} from './fleet.ts'
import { parseWorktreePorcelain, type WorktreeInfo } from './work.ts'

export interface WatchMol {
  mol: string
  state: string
  /** ready steps as {id,title,kind} — a watcher needs to name the step */
  ready: { id: string; title: string; kind: string }[]
  gates: string[]
  inProgress: string[]
  blocked: string[]
}

export interface WatchPrGate {
  pr: number
  link: string
  /** absent = the exit gate evaluated; present = the probe itself failed */
  ok?: boolean
  blockers?: string[]
  error?: string
}

export interface WatchGates {
  /** false when no review host resolved (or it died) — the section is
   *  `unavailable`, never a phantom dead fleet */
  available: boolean
  reason?: string
  prs: WatchPrGate[]
}

export interface WatchSnapshot {
  ts: string
  attention: string[]
  mols: WatchMol[]
  /** set when the mols plane itself threw — the section renders
   *  `unavailable` rather than a false "no open molecules" */
  molsError?: string
  gates: WatchGates
  fleet: {
    rows: FleetRow[]
    degraded: string[]
    conflicts: string[]
    /** branch→PR lookups that failed — a quiet PR column must not
     *  read as "no PRs exist" when the lookups errored */
    prErrors?: string[]
  }
}

/** `<git-common-dir>/bro/notify` — null outside a repo (notify warns
 *  and skips rather than failing the heartbeat). */
function mailboxDir(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'notify')
}

/** The heartbeat's answer: ready human gates, lost agents, blocked and
 *  unprobeable PR exit gates. Empty = the fleet is quiet. */
export function attentionOf(
  mols: WatchMol[],
  rows: FleetRow[],
  prs: WatchPrGate[]
): string[] {
  const attention: string[] = []
  for (const m of mols) {
    if (m.state.startsWith('error')) {
      attention.push(`mol ${m.mol} unreadable — ${m.state}`)
      continue
    }
    for (const g of m.gates) {
      const t = m.ready.find((s) => s.id === g)?.title
      const suffix = t === undefined ? '' : ` (${t})`
      attention.push(`gate ready — ${m.mol}: ${g}${suffix}`)
    }
  }
  for (const r of rows) {
    if (r.agent === 'lost — respawn?') {
      attention.push(`agent lost — ${r.step} (${r.title}) — respawn?`)
    }
  }
  for (const g of prs) {
    if (g.error !== undefined) {
      attention.push(`PR ${g.link} gate probe failed — ${g.error}`)
    } else if (g.ok === false) {
      attention.push(`PR ${g.link} blocked — ${(g.blockers ?? []).join('; ')}`)
    }
  }
  return attention
}

/** The notify dedup key — the snapshot minus its timestamp. --every
 *  re-emits only on transitions; a heartbeat reports change, not noise. */
export function snapshotKey(s: WatchSnapshot): string {
  return JSON.stringify({ ...s, ts: '' })
}

/** One atomic mailbox file — tmp+rename so a draining reader never sees
 *  a half-written event. */
export function emitMailbox(dir: string, text: string): boolean {
  const mb = mailboxDir(dir)
  if (mb === null) {
    return false
  }
  mkdirSync(mb, { recursive: true })
  const name = `watch-${Date.now()}-${randomBytes(4).toString('hex')}.txt`
  const tmp = join(mb, `.${name}.tmp`)
  writeFileSync(tmp, text)
  renameSync(tmp, join(mb, name))
  return true
}

/** mols section — every open molecule through nextStep; pure beads
 *  reads, no backend, no network. A molecule whose load/nextStep
 *  throws degrades to an `error` row — one bad mol must not blank
 *  the plane or kill the heartbeat. */
function collectMols(): WatchMol[] {
  return listMolecules().map((m) => {
    try {
      const n = nextStep(loadMolecule(m.id))
      return {
        mol: m.id,
        state: n.state,
        ready: n.ready.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
        gates: n.gates,
        inProgress: n.inProgress,
        blocked: n.blocked,
      }
    } catch (err) {
      return {
        mol: m.id,
        state: `error — ${err instanceof Error ? err.message : String(err)}`,
        ready: [],
        gates: [],
        inProgress: [],
        blocked: [],
      }
    }
  })
}

function worktreeList(): WorktreeInfo[] {
  try {
    return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  } catch {
    return []
  }
}

/** The act exit gate per distinct fleet PR — probed in parallel so a
 *  large fleet doesn't serialize one heartbeat into a long blocking
 *  sequence. A failed probe is recorded per-PR (`error`), not folded
 *  into "blocked" and never kills the rest. */
async function gateFleetPrs(
  rev: ReviewFacade,
  repo: string,
  rows: FleetRow[],
  dir: string
): Promise<WatchPrGate[]> {
  const act = loadBroConfig(dir).act
  const seen = new Set<number>()
  const targets: { pr: number; link: string }[] = []
  for (const row of rows) {
    const pr = row.prNum
    if (pr === undefined || seen.has(pr)) {
      continue
    }
    seen.add(pr)
    targets.push({ pr, link: row.pr ?? rev.prLink(repo, pr) })
  }
  return Promise.all(
    targets.map(async ({ pr, link }) => {
      try {
        const state = await fetchPrActState(rev, { repo, pr }, {
          ignoreChecks: act.ignoreChecks,
          maxRounds: act.maxRounds,
        })
        const gate = evaluateExitGate(state)
        return { pr, link, ok: gate.ok, blockers: gate.blockers }
      } catch (err) {
        return { pr, link, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}

/** The snapshot — pure reads across all three planes. Every plane is
 *  best-effort on its own: a throwing plane degrades its section, never
 *  kills the heartbeat. */
export async function collectSnapshot(dir: string): Promise<WatchSnapshot> {
  let mols: WatchMol[] = []
  let molsError: string | undefined
  try {
    mols = collectMols()
  } catch (err) {
    molsError = err instanceof Error ? err.message : String(err)
  }

  // --- fleet: same machinery as `bro fleet` ---
  const { byStep, degraded, conflicts } = await collectAgents(dir)
  let rev: ReviewFacade | undefined
  let repo = ''
  let gateReason: string | undefined
  try {
    rev = reviewHost(dir)
    repo = rev.resolveRepo([])
  } catch (err) {
    rev = undefined
    gateReason = err instanceof Error ? err.message : String(err)
  }
  const prErrors: string[] = []
  const rows = fleetRows(byStep, degraded.length > 0, rev, repo, worktreeList(), prErrors)

  // --- gates: no review host renders the section unavailable ---
  const gates: WatchGates =
    rev === undefined
      ? { available: false, reason: gateReason, prs: [] }
      : { available: true, prs: await gateFleetPrs(rev, repo, rows, dir) }

  const attention = attentionOf(mols, rows, gates.prs)
  for (const e of prErrors) {
    attention.push(`PR lookup failed — ${e}`)
  }
  if (molsError !== undefined) {
    attention.push(`mols plane failed — ${molsError}`)
  }

  return {
    ts: new Date().toISOString(),
    attention,
    mols,
    molsError,
    gates,
    fleet: { rows, degraded, conflicts, prErrors },
  }
}

function attentionLines(attention: string[]): string[] {
  return attention.length === 0 ? ['  (quiet)'] : attention.map((a) => `  ${a}`)
}

function molLines(mols: WatchMol[]): string[] {
  if (mols.length === 0) {
    return ['  no open molecules']
  }
  const head = ['mol', 'state', 'ready', 'gates', 'in-progress', 'blocked']
  const rows = mols.map((m) => [
    m.mol,
    m.state,
    m.ready.map((r) => r.id).join(',') || '—',
    m.gates.join(',') || '—',
    m.inProgress.join(',') || '—',
    m.blocked.join(',') || '—',
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (vals: string[]) =>
    '  ' + vals.map((v, i) => v.padEnd(w[i]!)).join('  ').trimEnd()
  return [line(head), ...rows.map(line)]
}

function gateVerdict(g: WatchPrGate): string {
  if (g.error !== undefined) {
    return `probe failed — ${g.error}`
  }
  return g.ok ? 'ok' : `blocked — ${(g.blockers ?? []).join('; ')}`
}

function gateLines(gates: WatchGates): string[] {
  if (!gates.available) {
    const reason = gates.reason === undefined ? '' : ` — ${gates.reason}`
    return [`  unavailable${reason}`]
  }
  if (gates.prs.length === 0) {
    return ['  no PRs in the fleet']
  }
  return gates.prs.map((g) => `  ${g.link}  ${gateVerdict(g)}`)
}

function fleetLines(fleet: WatchSnapshot['fleet']): string[] {
  const out =
    fleet.rows.length === 0
      ? ['  no open molecules — nothing in the fleet']
      : fleetTableLines(fleet.rows).map((l) => `  ${l}`)
  for (const d of fleet.degraded) {
    out.push(`  warning: backend degraded — ${d}`)
  }
  for (const c of fleet.conflicts) {
    out.push(`  warning: agent conflict — ${c}`)
  }
  for (const e of fleet.prErrors ?? []) {
    out.push(`  warning: PR lookup failed — ${e}`)
  }
  return out
}

/** Text render — attention first; an empty list is the "fleet is quiet"
 *  answer, printed as such rather than omitted. */
export function renderSnapshot(s: WatchSnapshot): string {
  return [
    `bro watch — ${s.ts}`,
    '',
    'attention',
    ...attentionLines(s.attention),
    '',
    'mols',
    ...(s.molsError === undefined ? molLines(s.mols) : [`  unavailable — ${s.molsError}`]),
    '',
    'gates',
    ...gateLines(s.gates),
    '',
    'fleet',
    ...fleetLines(s.fleet),
  ].join('\n')
}

/** Parsed watch flags — `--once` is the default so it needs no field. */
export function watchArgs(argv: string[]): {
  json: boolean
  notify: boolean
  everySec?: number
} {
  const everyRaw = flag(argv, '--every')
  const base = { json: argv.includes('--json'), notify: argv.includes('--notify') }
  if (everyRaw === undefined) {
    return base
  }
  const everySec = Number(everyRaw)
  // setTimeout clamps delays over 2^31-1 ms to ~1ms — a huge --every
  // would busy-tick instead of waiting, so it fails closed here.
  if (!Number.isFinite(everySec) || everySec <= 0 || everySec * 1000 > 0x7fffffff) {
    throw new Error(
      `--every needs a positive seconds value up to ${0x7fffffff / 1000}s, got "${everyRaw}"`
    )
  }
  return { ...base, everySec }
}

export async function runWatchCommand(argv: string[]): Promise<void> {
  let args: ReturnType<typeof watchArgs>
  try {
    args = watchArgs(argv)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  const { json, notify, everySec } = args
  const dir = process.cwd()

  if (notify && mailboxDir(dir) === null) {
    console.error('warning: --notify has no mailbox — not inside a git repo; skipping drops')
  }

  // The dedup key is the snapshot minus its timestamp — --notify re-emits
  // only on transitions, a heartbeat reports change not noise.
  let lastNotified = ''
  const tick = async (): Promise<void> => {
    const snap = await collectSnapshot(dir)
    const text = renderSnapshot(snap)
    console.log(json ? JSON.stringify(snap, null, 2) : text)
    if (notify) {
      const key = snapshotKey(snap)
      if (key !== lastNotified) {
        lastNotified = key
        try {
          emitMailbox(dir, text)
        } catch (err) {
          // mailbox write failures (permissions, disk, races) warn —
          // the heartbeat is best-effort and must not die on a drop
          console.error(
            `warning: mailbox drop failed — ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
  }

  await tick()
  if (everySec === undefined) {
    return
  }
  // --every: tick on a cadence until killed — the supervisor owns the
  // lifecycle; watch just keeps reporting.
  for (;;) {
    await new Promise((r) => setTimeout(r, everySec * 1000))
    await tick()
  }
}
