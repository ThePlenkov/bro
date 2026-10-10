/**
 * `bro watch` — the deterministic orchestrator heartbeat: one snapshot of
 * every read plane a supervisor glues together by hand today — open
 * molecules (nextStep), act exit gates for fleet PRs, the fleet itself,
 * and in-flight loop agents (spec bro-9lpn3 — silence is advisory, never
 * a kill). Spec: specs/sessions/bro-f4ot/bro-vf1j.md.
 *
 *   bro watch [--once]      one snapshot (default — the heartbeat call)
 *   bro watch --every N --for S   tick the snapshot every N seconds;
 *         --for bounds the loop — required for the session pulse, the
 *         exit is the event a session waits on (omitted = unbounded,
 *         only an external supervisor may own that lifecycle).
 *         The session pulse (bro-killn): holds <git-common>/bro/pulse.lock
 *         for its lifetime — one pulse per repo, a duplicate stands by —
 *         and refuses to run under BRO_AGENT_ID (workers never arm the
 *         cadence; the orchestrator session owns it)
 *   bro watch --notify      drop each tick's snapshot into the mailbox
 *   bro watch --json        machine-readable {ts, attention, mols, gates, fleet}
 *   bro watch install [--every N] [--print]   arm the session pulse —
 *         writes <git-common>/bro/pulse.json and strips any legacy
 *         systemd/crontab entry (OS timers are retired, bro-killn)
 *   bro watch uninstall     disarm the marker + strip any legacy entry
 *
 * `--every` is the pulse — the orchestrator session's bounded watcher
 * window; on its end the session runs one `bro drive` pass, digests,
 * and re-arms. Never claims, never mutates beads; the three writes are
 * `--notify`'s mailbox drop, the heartbeat file (`<git-common>/bro/
 * heartbeat.json` — the durable last-known-state read by `bro status`
 * and session-start context; bro-dxoa5), and the janitor — `runJanitor`
 * (bro-f6zp) reaps dead session/agent state under `<git-common>/bro/`
 * on each tick, because watch is the cadence a reaper survives on.
 *
 * Mailbox — `<git-common-dir>/bro/notify/`, the contract the notify
 * connector (bro-d8zo) drains. One atomic file per emission
 * (`watch-<epoch_ms>-<rand>.txt`, tmp+rename). In `--every` mode an
 * unchanged snapshot is not re-emitted — a heartbeat reports
 * transitions, not noise.
 */
import {
  awaitFileLock,
  dropMailbox,
  git,
  gitTry,
  janitorDidWork,
  janitorLine,
  mailboxDir,
  reviewHost,
  runJanitor,
  sweepOrphanProcs,
  wallText,
  type JanitorReport,
  type ProviderWall,
  type ReviewFacade,
} from '@broject/core'
import { checkHistory, evaluateExitGate, fetchPrActState } from '@broject/act'
import { listMolecules, loadMolecule, nextStep } from '@broject/convoy'
import { loopSection } from '@broject/loop'
import { loadBroConfig } from '../plugins.ts'
import { flag } from './args.ts'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
import {
  collectAgents,
  fleetRows,
  fleetTableLines,
  type FleetRow,
} from './fleet.ts'
import { collectLoopRuns, type LoopRunView } from './loop-state.ts'
import { providerWallsFor } from '../agent-connectors.ts'
import { parseWorktreePorcelain, type WorktreeInfo } from './work.ts'
import { installWatch, uninstallWatch } from './watch-install.ts'
import { isOrchestratorSession, pulseLockPath } from './watch-pulse.ts'
import { writeHeartbeat } from './watch-heartbeat.ts'
import { watchSection, type WatchConfig } from './watch-config.ts'

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
  /** advisory-check alerts (silent reviewers) — never blockers */
  alerts?: string[]
  error?: string
}

export interface WatchGates {
  /** false when no review host resolved (or it died) — the section is
   *  `unavailable`, never a phantom dead fleet */
  available: boolean
  reason?: string
  /** the probe machinery itself threw — distinct from per-PR `error`:
   *  every gate is unprobed, which is not "no PRs" */
  error?: string
  /** branch→PR lookups that failed — an empty `prs` then means
   *  "couldn't resolve", not "nothing to gate" */
  lookupErrors?: string[]
  prs: WatchPrGate[]
}

/** The loop plane — in-flight `bro loop` worker records. `stallMin` is
 *  the advisory threshold attention judged against (loop.stallMin), so
 *  a consumer reads the verdict with the bound that produced it. */
export interface WatchLoop {
  stallMin: number
  runs: LoopRunView[]
  /** set when the loop plane itself threw — renders `unavailable`,
   *  never a false "no loop runs" */
  error?: string
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
    /** Provider walls derived from the registry (spec bro-1x7p) —
     *  surfaced in attention; absent on older snapshots. */
    walls?: ProviderWall[]
    /** the wall derivation itself threw (corrupt registry) — additive
     *  data failed, never the rows; renders as a warning, not
     *  `unavailable` */
    wallsError?: string
    /** set when the fleet plane itself threw (agent backends or the
     *  molecule re-read in fleetRows) — the section renders
     *  `unavailable`, never a false empty fleet */
    error?: string
  }
  /** This tick's janitor report — set only when it reaped or capped
   *  something; the attention line carries the same news in text. */
  janitor?: JanitorReport
  /** In-flight `bro loop` workers + their output-silence read. Advisory
   *  data only — a stale log is reported, never killed (bro-9lpn3). */
  loop: WatchLoop
}

/** The heartbeat's answer: ready human gates, lost agents, walled
 *  providers, blocked and unprobeable PR exit gates. Empty = the fleet
 *  is quiet. */
export function attentionOf(
  mols: WatchMol[],
  rows: FleetRow[],
  prs: WatchPrGate[],
  walls: ProviderWall[] = [],
  loop: WatchLoop = { stallMin: 0, runs: [] }
): string[] {
  return [
    ...molAttention(mols),
    ...agentAttention(rows),
    ...loopAttention(loop),
    ...walls.map((w) => `provider ${wallText(w)}`),
    ...prAttention(prs),
  ]
}

function molAttention(mols: WatchMol[]): string[] {
  const out: string[] = []
  for (const m of mols) {
    if (m.state.startsWith('error')) {
      out.push(`mol ${m.mol} unreadable — ${m.state}`)
      continue
    }
    for (const g of m.gates) {
      const t = m.ready.find((s) => s.id === g)?.title
      const suffix = t === undefined ? '' : ` (${t})`
      out.push(`gate ready — ${m.mol}: ${g}${suffix}`)
    }
  }
  return out
}

function agentAttention(rows: FleetRow[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.agent === 'lost — respawn?') {
      out.push(`agent lost — ${r.step} (${r.title}) — respawn?`)
    }
    if (r.agent.startsWith('blocked — ')) {
      out.push(`agent ${r.agent} — ${r.step} (${r.title})`)
    }
  }
  return out
}

/** Loop-worker advisories — a live spawn silent past loop.stallMin, or a
 *  record whose pid is gone (a crashed loop's residue). Reported for the
 *  orchestrator's judgment; watch never stops or respawns anything. */
function loopAttention(loop: WatchLoop): string[] {
  const out: string[] = []
  for (const r of loop.runs) {
    if (r.state === 'dead') {
      out.push(`loop agent ${r.beadId} — pid ${r.pid ?? '?'} gone — crashed run's record`)
      continue
    }
    if (
      loop.stallMin > 0 &&
      r.silentMs !== null &&
      r.silentMs >= loop.stallMin * 60_000
    ) {
      out.push(
        `loop agent ${r.beadId} — output silent ${Math.floor(r.silentMs / 60_000)}m — inspect?`
      )
    }
  }
  return out
}

function prAttention(prs: WatchPrGate[]): string[] {
  const out: string[] = []
  for (const g of prs) {
    if (g.error !== undefined) {
      out.push(`PR ${g.link} gate probe failed — ${g.error}`)
    } else if (g.ok === false) {
      out.push(`PR ${g.link} blocked — ${(g.blockers ?? []).join('; ')}`)
    }
    for (const a of g.alerts ?? []) {
      out.push(`PR ${g.link} — ${a}`)
    }
  }
  return out
}

/** The notify dedup key — the snapshot minus its timestamp. --every
 *  re-emits only on transitions; a heartbeat reports change, not noise. */
export function snapshotKey(s: WatchSnapshot): string {
  return JSON.stringify({ ...s, ts: '' })
}

/** One atomic mailbox file — tmp+rename (dropMailbox in core) so a
 *  draining reader never sees a half-written event. Outside a repo
 *  there is no mailbox — report false instead of throwing. */
export function emitMailbox(dir: string, text: string): boolean {
  const mb = mailboxDir(dir)
  if (mb === null) {
    return false
  }
  dropMailbox(mb, text, 'watch')
  return true
}

/** --notify's transition drop: a changed snapshot mails once. Marked
 *  notified only on a successful emit — a transient failure retries on
 *  the next tick, and a throw warns without killing the heartbeat. */
function dropTransition(
  dir: string,
  snap: WatchSnapshot,
  text: string,
  lastNotified: string
): string {
  const key = snapshotKey(snap)
  if (key === lastNotified) {
    return lastNotified
  }
  try {
    return emitMailbox(dir, text) ? key : lastNotified
  } catch (err) {
    console.error(
      `warning: mailbox drop failed — ${err instanceof Error ? err.message : String(err)}`
    )
    return lastNotified
  }
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

function worktreeList(errors?: string[]): WorktreeInfo[] {
  try {
    return parseWorktreePorcelain(git(['worktree', 'list', '--porcelain']))
  } catch (err) {
    // a failed worktree read hides every worktree branch's PR — report
    // it instead of letting gates claim "no PRs in the fleet"
    errors?.push(`worktree list: ${err instanceof Error ? err.message : String(err)}`)
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
    // every PR on the branch is gated — prNum is only the display pick
    const prs = row.prNums ?? (row.prNum === undefined ? [] : [row.prNum])
    for (const pr of prs) {
      if (seen.has(pr)) {
        continue
      }
      seen.add(pr)
      targets.push({ pr, link: pr === row.prNum && row.pr !== undefined ? row.pr : rev.prLink(repo, pr) })
    }
  }
  return Promise.all(
    targets.map(async ({ pr, link }) => {
      try {
        const state = await fetchPrActState(rev, { repo, pr }, {
          ignoreChecks: act.ignoreChecks,
          checkHistory: checkHistory(dir),
          maxRounds: act.maxRounds,
          docsPaths: act.docsPaths,
          docsMaxRounds: act.docsMaxRounds,
        })
        const gate = evaluateExitGate(state)
        return { pr, link, ok: gate.ok, blockers: gate.blockers, alerts: gate.alerts }
      } catch (err) {
        return { pr, link, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Each plane degrades to its own error state — the snapshot composes
 *  results, it never dies on one plane. */
function molsPlane(): { mols: WatchMol[]; error?: string } {
  try {
    return { mols: collectMols() }
  } catch (err) {
    return { mols: [], error: errText(err) }
  }
}

interface ResolvedHost {
  rev?: ReviewFacade
  repo: string
  reason?: string
}

function hostPlane(dir: string): ResolvedHost {
  try {
    const rev = reviewHost(dir)
    return { rev, repo: rev.resolveRepo([]) }
  } catch (err) {
    return { repo: '', reason: errText(err) }
  }
}

/** fleet — same machinery as `bro fleet`; a throwing read (backends,
 *  worktree list, the molecule re-read in fleetRows) degrades the
 *  section, never the heartbeat. */
async function fleetPlane(
  dir: string,
  host: ResolvedHost
): Promise<WatchSnapshot['fleet']> {
  try {
    const { byStep, degraded, conflicts } = await collectAgents(dir)
    const prErrors: string[] = []
    const rows = fleetRows(
      byStep,
      degraded.length > 0,
      host.rev,
      host.repo,
      worktreeList(prErrors),
      prErrors
    )
    // walls are additive data — a failed derivation (corrupt registry)
    // degrades this one datum, never the rows the plane collected
    let walls: ProviderWall[] | undefined
    let wallsError: string | undefined
    try {
      walls = providerWallsFor(dir)
    } catch (err) {
      wallsError = errText(err)
    }
    return { rows, degraded, conflicts, prErrors, walls, wallsError }
  } catch (err) {
    return { rows: [], degraded: [], conflicts: [], prErrors: [], error: errText(err) }
  }
}

/** gates — no review host renders the section unavailable; a throwing
 *  probe renders `error`, distinct from a host failure. */
async function gatesPlane(
  dir: string,
  host: ResolvedHost,
  rows: FleetRow[],
  prErrors: string[]
): Promise<WatchGates> {
  if (host.rev === undefined) {
    return { available: false, reason: host.reason, prs: [] }
  }
  const lookupErrors = prErrors.length > 0 ? prErrors : undefined
  try {
    return {
      available: true,
      prs: await gateFleetPrs(host.rev, host.repo, rows, dir),
      lookupErrors,
    }
  } catch (err) {
    return { available: true, error: errText(err), prs: [], lookupErrors }
  }
}

/** loop — run records under <git-common>/bro/loop/. Pure fs + pid
 *  reads; a throwing plane degrades its section, never the heartbeat. */
function loopPlane(dir: string): WatchLoop {
  try {
    const cfg = loadBroConfig(dir) as Record<string, unknown>
    return { runs: collectLoopRuns(dir), stallMin: loopSection(cfg.loop).stallMin }
  } catch (err) {
    return { runs: [], stallMin: 0, error: errText(err) }
  }
}

/** The snapshot — pure reads across all planes. Every plane is
 *  best-effort on its own: a throwing plane degrades its section, never
 *  kills the heartbeat. */
export async function collectSnapshot(dir: string): Promise<WatchSnapshot> {
  const molsPlane_ = molsPlane()
  const host = hostPlane(dir)
  const fleet = await fleetPlane(dir, host)
  const gates = await gatesPlane(dir, host, fleet.rows, fleet.prErrors ?? [])
  const loop = loopPlane(dir)

  const attention = attentionOf(
    molsPlane_.mols,
    fleet.rows,
    gates.prs,
    fleet.walls ?? [],
    loop
  )
  for (const e of fleet.prErrors ?? []) {
    attention.push(`PR lookup failed — ${e}`)
  }
  if (gates.error !== undefined) {
    attention.push(`gates probe failed — ${gates.error}`)
  }
  if (fleet.error !== undefined) {
    attention.push(`fleet plane failed — ${fleet.error}`)
  }
  if (molsPlane_.error !== undefined) {
    attention.push(`mols plane failed — ${molsPlane_.error}`)
  }
  if (loop.error !== undefined) {
    attention.push(`loop plane failed — ${loop.error}`)
  }

  return {
    ts: new Date().toISOString(),
    attention,
    mols: molsPlane_.mols,
    molsError: molsPlane_.error,
    gates,
    fleet,
    loop,
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
  const verdict = g.ok ? 'ok' : `blocked — ${(g.blockers ?? []).join('; ')}`
  return (g.alerts ?? []).length === 0 ? verdict : `${verdict} +alert: ${g.alerts!.join('; ')}`
}

function gateLines(gates: WatchGates): string[] {
  if (!gates.available) {
    const reason = gates.reason === undefined ? '' : ` — ${gates.reason}`
    return [`  unavailable${reason}`]
  }
  if (gates.error !== undefined) {
    return [`  probe failed — ${gates.error}`]
  }
  const lookupWarn =
    gates.lookupErrors === undefined
      ? []
      : [`  warning: ${gates.lookupErrors.length} branch→PR lookup(s) failed — see fleet`]
  if (gates.prs.length === 0) {
    return gates.lookupErrors === undefined
      ? ['  no PRs in the fleet']
      : ['  no PRs resolved', ...lookupWarn]
  }
  return [...gates.prs.map((g) => `  ${g.link}  ${gateVerdict(g)}`), ...lookupWarn]
}

function fleetLines(fleet: WatchSnapshot['fleet']): string[] {
  const out =
    fleet.error !== undefined
      ? [`  unavailable — ${fleet.error}`]
      : fleet.rows.length === 0
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
  for (const w of fleet.walls ?? []) {
    out.push(`  ${wallText(w)}`)
  }
  if (fleet.wallsError !== undefined) {
    out.push(`  warning: provider walls unreadable — ${fleet.wallsError}`)
  }
  return out
}

function loopLines(loop: WatchLoop): string[] {
  if (loop.error !== undefined) {
    return [`  unavailable — ${loop.error}`]
  }
  if (loop.runs.length === 0) {
    return ['  no loop agents on record']
  }
  const head = ['run', 'state', 'pid', 'silent', 'log']
  const rows = loop.runs.map((r) => [
    r.beadId,
    r.state,
    String(r.pid ?? '—'),
    r.silentMs === null ? '—' : `${Math.floor(r.silentMs / 60_000)}m`,
    r.log ?? '—',
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (vals: string[]) =>
    '  ' + vals.map((v, i) => v.padEnd(w[i]!)).join('  ').trimEnd()
  return [line(head), ...rows.map(line)]
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
    '',
    'loop',
    ...loopLines(s.loop),
  ].join('\n')
}

/** Parsed watch flags — `--once` is the default so it needs no field. */
export function watchArgs(argv: string[]): {
  json: boolean
  notify: boolean
  everySec?: number
  forSec?: number
} {
  const everyRaw = flag(argv, '--every')
  const forRaw = flag(argv, '--for')
  const base = { json: argv.includes('--json'), notify: argv.includes('--notify') }
  if (everyRaw === undefined) {
    if (forRaw !== undefined) {
      throw new Error('--for bounds a --every loop — pass both or neither')
    }
    return base
  }
  const everySec = Number(everyRaw)
  // setTimeout clamps delays over 2^31-1 ms to ~1ms — a huge --every
  // would busy-tick instead of waiting; a sub-floor --every is a busy
  // loop either way. Both bounds fail closed here.
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    throw new Error(
      `--every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw}"`
    )
  }
  if (forRaw === undefined) {
    return { ...base, everySec }
  }
  const forSec = Number(forRaw)
  // a --for whose ms conversion overflows to Infinity is no bound at all
  if (!Number.isFinite(forSec) || forSec < everySec || !Number.isFinite(forSec * 1000)) {
    throw new Error(`--for needs a finite seconds value ≥ --every (${everySec}s), got "${forRaw}"`)
  }
  return { ...base, everySec, forSec }
}

/** One reap for one tick — the report when it did work plus the
 *  attention line. Housekeeping must never kill the heartbeat: a
 *  throwing janitor surfaces as an attention line, not a dead watch
 *  (bro-f6zp — a silent janitor is indistinguishable from a broken one). */
function tickJanitor(dir: string): { janitor?: JanitorReport; note: string } {
  // Orphaned bd procs ride the same tick: a supervisor dying mid-call
  // leaves them holding the embedded noms LOCK forever (bro-8845g).
  // Scope by repo root — a watch launched from a subdirectory would
  // never see the root's orphans otherwise.
  const repoRoot = gitTry(['-C', dir, 'rev-parse', '--show-toplevel']).out.trim() || dir
  let orphanNote = ''
  try {
    const o = sweepOrphanProcs('bd', repoRoot)
    if (o.signaled.length > 0 || o.failed.length > 0) {
      const failed = o.failed.length > 0 ? ` (${o.failed.length} resisted SIGTERM)` : ''
      orphanNote = `bd-orphans: signaled ${o.signaled.length}${failed}`
    }
  } catch (err) {
    orphanNote = `bd-orphan sweep failed — ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    const j = runJanitor(dir)
    const note = j !== null && janitorDidWork(j) ? janitorLine(j) : ''
    return { janitor: j ?? undefined, note: [note, orphanNote].filter((s) => s !== '').join(' · ') }
  } catch (err) {
    return { note: [orphanNote, `janitor failed — ${err instanceof Error ? err.message : String(err)}`].filter((s) => s !== '').join(' · ') }
  }
}

/** `install|uninstall` — arm/disarm the session pulse (bro-killn):
 *  install writes the want-marker session-start rearms from and strips
 *  any legacy systemd/crontab entry; uninstall removes both. */
function runWatchSched(argv: string[]): void {
  const dir = process.cwd()
  const cfg =
    ((loadBroConfig(dir) as Record<string, unknown>).watch as WatchConfig | undefined) ??
    watchSection(undefined)
  if (argv[0] === 'uninstall') {
    const r = uninstallWatch(dir)
    console.log(r.detail)
    if (r.state === 'error') {
      process.exit(1)
    }
    return
  }
  const everyRaw = flag(argv, '--every')
  const everySec = everyRaw === undefined ? cfg.intervalSec : Number(everyRaw)
  // the shared floor still matters: the armed cadence lands verbatim in
  // the marker and the rearm command — a 0.05s pulse is a busy loop
  if (!Number.isFinite(everySec) || everySec < MIN_INTERVAL_SEC || everySec > MAX_INTERVAL_SEC) {
    console.error(
      `error: --every needs a seconds value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${everyRaw ?? everySec}"`
    )
    process.exit(2)
  }
  const r = installWatch(dir, { everySec, pulseSec: cfg.pulseSec, print: argv.includes('--print') })
  console.log(r.detail)
  if (r.state === 'error') {
    process.exit(1)
  }
}

export async function runWatchCommand(argv: string[]): Promise<void> {
  if (argv[0] === 'install' || argv[0] === 'uninstall') {
    runWatchSched(argv.slice(1))
    return
  }
  let args: ReturnType<typeof watchArgs>
  try {
    args = watchArgs(argv)
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  const { json, notify, everySec, forSec } = args
  const dir = process.cwd()

  if (notify && mailboxDir(dir) === null) {
    console.error('warning: --notify has no mailbox — not inside a git repo; skipping drops')
  }

  // The dedup key is the snapshot minus its timestamp — --notify re-emits
  // only on transitions, a heartbeat reports change not noise.
  let lastNotified = ''
  const tick = async (): Promise<void> => {
    // the janitor rides the heartbeat — one reap per tick, before the
    // snapshot so the planes read post-reap state (bro-f6zp)
    const { janitor, note } = tickJanitor(dir)
    const snap = await collectSnapshot(dir)
    snap.janitor = janitor
    if (note !== '') {
      snap.attention.push(note)
    }
    const text = renderSnapshot(snap)
    console.log(json ? JSON.stringify(snap, null, 2) : text)
    try {
      // the durable heartbeat file — mailbox drops expire in an hour,
      // this is what overnight state reads from (bro-dxoa5)
      writeHeartbeat(dir, snap)
    } catch (err) {
      console.error(
        `warning: heartbeat file write failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (notify) {
      lastNotified = dropTransition(dir, snap, text, lastNotified)
    }
  }

  const expired = () => {
    console.log(
      json
        ? JSON.stringify({ ts: new Date().toISOString(), event: 'expired' })
        : 'watch: --for expired'
    )
  }
  if (everySec === undefined) {
    await tick()
    return
  }
  await runWatchPulse(dir, everySec, forSec, tick, expired)
}

/** The session pulse (bro-killn): orchestrator-only, one per repo via
 *  `bro/pulse.lock`, bounded by --for measured from entry so a standby
 *  behind the incumbent spends the same budget as ticking. */
async function runWatchPulse(
  dir: string,
  everySec: number,
  forSec: number | undefined,
  tick: () => Promise<void>,
  expired: () => void
): Promise<void> {
  // GUARD (bro-killn): spawned workers pin BRO_AGENT_ID at spawn — they
  // must never arm the cadence; the orchestrator session owns it. The
  // connector's nudge applies the same predicate on the read side.
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm the watch pulse; ' +
        'the orchestrator session owns the cadence'
    )
    process.exit(2)
  }
  // The bound starts here, before the lock wait: a standby behind the
  // incumbent spends the same --for budget as ticking — a wait that eats
  // the whole window exits without a tick (the incumbent covered it).
  // Monotonic clock: a wall-clock step backward must not stretch the
  // bound past its elapsed budget.
  const deadline =
    forSec === undefined ? Number.POSITIVE_INFINITY : performance.now() + forSec * 1000
  // One pulse per repo: `bro/pulse.lock` is held heartbeated for the
  // process lifetime — a duplicate stands by behind the incumbent and
  // takes over when it exits, never ticks concurrently (spec bro-2duu9).
  // The lock's holder pid is also the session-start liveness read.
  const lock = pulseLockPath(dir)
  const releasePulse =
    lock === null
      ? () => {}
      : await awaitFileLock(lock, {
          label: 'watch pulse lock',
          onStandby: (pid) =>
            console.error(
              `bro watch: pulse already held${pid === null ? '' : ` by pid ${pid}`} — standing by`
            ),
        })
  try {
    if (performance.now() >= deadline) {
      expired()
      return
    }
    await tick()
    // --every: tick on a cadence until killed — or until --for expires.
    // An unbounded watch is only legal while a supervisor owns the
    // lifecycle; session-side watchers must pass --for so their exit
    // exists as an event.
    for (;;) {
      if (performance.now() >= deadline) {
        expired()
        return
      }
      // cap the sleep at the remaining budget so expiry lands on its
      // boundary, not one full --every late
      await new Promise((r) =>
        setTimeout(r, Math.min(everySec * 1000, deadline - performance.now()))
      )
      if (performance.now() >= deadline) {
        expired()
        return
      }
      await tick()
    }
  } finally {
    releasePulse()
  }
}
