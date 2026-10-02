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
  gates: WatchGates
  fleet: { rows: FleetRow[]; degraded: string[]; conflicts: string[] }
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
    for (const g of m.gates) {
      const t = m.ready.find((s) => s.id === g)?.title
      attention.push(`gate ready — ${m.mol}: ${g}${t === undefined ? '' : ` (${t})`}`)
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
  const name = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  const tmp = join(mb, `.${name}.tmp`)
  writeFileSync(tmp, text)
  renameSync(tmp, join(mb, name))
  return true
}

/** The snapshot — pure reads across all three planes. Every plane is
 *  best-effort on its own: a throwing plane degrades its section, never
 *  kills the heartbeat. */
export async function collectSnapshot(dir: string): Promise<WatchSnapshot> {
  // --- mols: pure beads reads ---
  const mols: WatchMol[] = listMolecules().map((m) => {
    const n = nextStep(loadMolecule(m.id))
    return {
      mol: m.id,
      state: n.state,
      ready: n.ready.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
      gates: n.gates,
      inProgress: n.inProgress,
      blocked: n.blocked,
    }
  })

  // --- fleet: same machinery as `bro fleet` ---
  const { byStep, degraded, conflicts } = await collectAgents(dir)
  const worktrees = (() => {
    try {
      return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
    } catch {
      return [] as WorktreeInfo[]
    }
  })()
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
  const rows = fleetRows(byStep, degraded.length > 0, rev, repo, worktrees)

  // --- gates: the act exit gate per fleet PR ---
  const gates: WatchGates = { available: rev !== undefined, reason: gateReason, prs: [] }
  if (rev !== undefined) {
    const act = loadBroConfig(dir).act
    const seen = new Set<number>()
    for (const row of rows) {
      const pr = row.prNum
      if (pr === undefined || seen.has(pr)) {
        continue
      }
      seen.add(pr)
      const link = row.pr ?? rev.prLink(repo, pr)
      try {
        const state = await fetchPrActState(rev, { repo, pr }, {
          ignoreChecks: act.ignoreChecks,
          maxRounds: act.maxRounds,
        })
        const gate = evaluateExitGate(state)
        gates.prs.push({ pr, link, ok: gate.ok, blockers: gate.blockers })
      } catch (err) {
        // a per-PR probe failure is reported, not folded into "blocked" —
        // an unreachable host is not a red gate
        gates.prs.push({ pr, link, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return {
    ts: new Date().toISOString(),
    attention: attentionOf(mols, rows, gates.prs),
    mols,
    gates,
    fleet: { rows, degraded, conflicts },
  }
}

/** Text render — attention first; an empty list is the "fleet is quiet"
 *  answer, printed as such rather than omitted. */
export function renderSnapshot(s: WatchSnapshot): string {
  const out: string[] = [`bro watch — ${s.ts}`, '']
  out.push('attention')
  if (s.attention.length === 0) {
    out.push('  (quiet)')
  } else {
    for (const a of s.attention) {
      out.push(`  ${a}`)
    }
  }
  out.push('', 'mols')
  if (s.mols.length === 0) {
    out.push('  no open molecules')
  } else {
    const rows = s.mols.map((m) => [
      m.mol,
      m.state,
      m.ready.map((r) => r.id).join(',') || '—',
      m.gates.join(',') || '—',
      m.inProgress.join(',') || '—',
      m.blocked.join(',') || '—',
    ])
    const head = ['mol', 'state', 'ready', 'gates', 'in-progress', 'blocked']
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
    out.push('  ' + head.map((h, i) => h.padEnd(w[i]!)).join('  ').trimEnd())
    for (const r of rows) {
      out.push('  ' + r.map((c, i) => c.padEnd(w[i]!)).join('  ').trimEnd())
    }
  }
  out.push('', 'gates')
  if (!s.gates.available) {
    out.push(`  unavailable${s.gates.reason === undefined ? '' : ` — ${s.gates.reason}`}`)
  } else if (s.gates.prs.length === 0) {
    out.push('  no PRs in the fleet')
  } else {
    for (const g of s.gates.prs) {
      const verdict =
        g.error !== undefined
          ? `probe failed — ${g.error}`
          : g.ok
            ? 'ok'
            : `blocked — ${(g.blockers ?? []).join('; ')}`
      out.push(`  ${g.link}  ${verdict}`)
    }
  }
  out.push('', 'fleet')
  if (s.fleet.rows.length === 0) {
    out.push('  no open molecules — nothing in the fleet')
  } else {
    for (const l of fleetTableLines(s.fleet.rows)) {
      out.push(`  ${l}`)
    }
  }
  for (const d of s.fleet.degraded) {
    out.push(`  warning: backend degraded — ${d}`)
  }
  for (const c of s.fleet.conflicts) {
    out.push(`  warning: agent conflict — ${c}`)
  }
  return out.join('\n')
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
  if (!Number.isFinite(everySec) || everySec <= 0) {
    throw new Error(`--every needs a positive seconds value, got "${everyRaw}"`)
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
        emitMailbox(dir, text)
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
