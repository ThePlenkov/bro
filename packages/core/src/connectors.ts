/**
 * Connectors — bro's boundary to external SYSTEMS. A connector is the
 * system (beads, github, gitlab, jira, sonar); a facade is a capability
 * it provides, exposed as an OPTIONAL member — presence advertises the
 * capability, absence is honest ("jira has no reviews"), never faked.
 *
 * Commands ask for a facade, never a connector:
 *
 *   facade('tasks', { dir })      → the configured/detected TaskStore
 *   connectorHooks({ dir })       → every connector's hook probes
 *
 * Resolution precedence for a named facade:
 *   1. explicit opts.connector
 *   2. bro.config.json "connectors": { "<facade>": "<name>" }
 *   3. remote match — a connector whose matchRemote() answers the
 *      origin URL wins over registry order
 *   4. first registered provider (built-ins register first)
 *
 * Facade interfaces are named by domain semantics — threads, checks,
 * mergeable — never vendor API names (no checkRuns/graphql in the
 * contract). New facades join FacadeMap + Connector together, and only
 * when a real consumer exists.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitTry } from './git.ts'
import type { JudgeFacade } from './judge.ts'
import type { ReviewFacade } from './review.ts'
import type { SpecStore } from './specs.ts'
import type { TaskRow, TaskStore } from './tasks.ts'
import { bdActor, taskStore } from './tasks.ts'

export interface ConnectorCtx {
  /** Working dir — repo root for project-scoped facades, the resolved
   *  global dir for user-level ones (same contract as taskStore(dir)). */
  dir: string
  /** Firing session's id — lets probes distinguish this session's claims
   *  (recorded in `<git-common-dir>/bro/hooks/<session>.<aspect>` markers)
   *  from foreign live work. Absent outside hook events. */
  sessionId?: string
}

/** Capability → facade type. Optional on Connector; required here once
 *  the facade exists. `findings`, `sast` join when their first real
 *  consumer lands. */
export interface FacadeMap {
  tasks: TaskStore
  reviews: ReviewFacade
  specs: SpecStore
  judge: JudgeFacade
}

export type MaybePromise<T> = T | Promise<T>

/** One system's answer to "may this session stop?" — the hook applies
 *  the arming policy; the connector only reports state:
 *  - `block`    — reason line, fires only when the session armed `aspect`
 *  - `armedHint`— context for an armed session that isn't blocked
 *  - `passive`  — ambient context for sessions that never armed it */
export interface GateContribution {
  /** Arming aspect — matches the post-tool marker name ('act', 'drill',
   *  'work', or a connector-owned name). */
  aspect: string
  block?: string
  armedHint?: string
  passive?: string
}

/** A connector's verdict on an about-to-run tool call — the guard plane's
 *  vocabulary. `block` vetoes the call outright; `input` rewrites the
 *  call's tool_input (merged across connectors in order). Both absent is
 *  abstention. */
export interface PreToolVerdict {
  /** Reason line — presence means "do not run this". */
  block?: string
  /** Args override — merged onto the call's tool_input. */
  input?: Record<string, unknown>
}

/** Context a connector contributes to the agent lifecycle — the
 *  per-connector answer to "what does this system know that the session
 *  must see". All probes are fail-open: a wedged system yields no lines,
 *  never a stalled hook. Probes may be async — a review host's gate
 *  check is a network call. */
export interface ConnectorHooks {
  /** Ambient context lines for session-start rehydration — e.g. beads
   *  reports the ready queue. */
  sessionStart?(ctx: ConnectorCtx): MaybePromise<string[]>
  /** Signals that OTHER live work exists here — claimed items, held
   *  slots; grouped under the parallel-work nudge, never a block. */
  parallelWork?(ctx: ConnectorCtx): MaybePromise<string[]>
  /** Prompt-submit context — the raw prompt lets each system spot its
   *  own references (github sees PR URLs, jira would see issue keys). */
  promptSubmit?(ctx: ConnectorCtx, prompt: string): MaybePromise<string[]>
  /** Post-tool context — cheap per-event probes that run on every tool
   *  landing, success or not; the notify connector drains the session
   *  mailbox here so child events arrive mid-turn. */
  postTool?(ctx: ConnectorCtx): MaybePromise<string[]>
  /** Stop-gate contributions — non-empty `block` means the session has
   *  unfinished business in this system. */
  stopGate?(ctx: ConnectorCtx): MaybePromise<GateContribution[]>
  /** Pre-execution verdicts — the guard plane: veto a tool call or
   *  rewrite its args before it runs (opencode `tool.execute.before`,
   *  claude `PreToolUse`). */
  preTool?(
    ctx: ConnectorCtx,
    input: { tool: string; input: Record<string, unknown> }
  ): MaybePromise<PreToolVerdict[]>
}

export interface Connector {
  readonly name: string
  /** Remote-URL matcher — the connector claims hosts it can serve
   *  (github.com, gitlab.*, a self-hosted domain). Drives facade
   *  auto-detect ahead of registry order. */
  matchRemote?(url: string): boolean
  /** Project-layout matcher — the connector claims repos whose
   *  directories it recognizes (`.specify/`, `openspec/`). Tried after
   *  matchRemote for facades where the project picks the tool, not the
   *  host (specs). */
  matchDir?(dir: string): boolean
  /** Auth/readiness probe — the SYSTEM owns its credential check, so a
   *  facade-backed command on a foreign host never demands `gh auth`.
   *  null = ready; a string is the remediation line a command prints.
   *  Sync: probes shell out like the rest of the facade surface — a
   *  non-string return (an async probe) is reported back as the
   *  plugin's defect, never awaited. */
  auth?(ctx: ConnectorCtx): string | null
  tasks?(ctx: ConnectorCtx): TaskStore
  reviews?(ctx: ConnectorCtx): ReviewFacade
  specs?(ctx: ConnectorCtx): SpecStore
  judge?(ctx: ConnectorCtx): JudgeFacade
  hooks?(ctx: ConnectorCtx): ConnectorHooks
}

// --- built-in: beads -----------------------------------------------------------

const shortTitle = (t: string | undefined): string => {
  const flat = (t ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

/** Bead ids this session claimed — the `task` aspect marker records one
 *  claim per detail line (line 1 is the timestamp). No session or no
 *  marker → nothing is "mine". Exported for policy connectors (sdd)
 *  that scope their nudges to the session's own claims.
 *
 *  The marker is written from command classification alone, so these are
 *  *attempted* claims: `bro work enter <bead>` arms the id even when its
 *  best-effort claim was refused (another actor holds the bead). Confirm
 *  real ownership per row with `isOwnClaim` before treating one as ours. */
export function sessionTaskClaims(ctx: ConnectorCtx): Set<string> {
  const mine = new Set<string>()
  if (!ctx.sessionId) {
    return mine
  }
  try {
    const gd = gitTry(['-C', ctx.dir, 'rev-parse', '--git-common-dir'])
    if (gd.code !== 0) {
      return mine
    }
    // --git-common-dir is relative in the main worktree ('.git') and
    // absolute in linked ones — resolve against ctx.dir, never cwd
    const safe = ctx.sessionId.replace(/[^\w.-]/g, '_')
    const marker = join(resolve(ctx.dir, gd.out.trim()), 'bro', 'hooks', `${safe}.task`)
    for (const d of readFileSync(marker, 'utf8').split('\n').slice(1)) {
      const id = d.trim()
      if (id) {
        mine.add(id)
      }
    }
  } catch {
    // no marker file — the session claimed nothing
  }
  return mine
}

/** Does `row` belong to this session's claims? The marker alone cannot
 *  say — it records attempts, and a refused `bro work enter` claim leaves
 *  the id armed while another actor holds the bead. Ownership is real only
 *  when the store's assignee matches this actor — pass the *serving*
 *  store's claim identity (`store.actor?.()`); a foreign backend's
 *  assignee is in its own identity space, never comparable to bdActor.
 *  An unverifiable row (missing assignee, unresolvable/absent actor)
 *  keeps the marker's word — probes stay fail-open rather than
 *  re-nudging on claims we can't disprove. */
export function isOwnClaim(row: TaskRow, mine: Set<string>, actor: string): boolean {
  if (!mine.has(row.id)) {
    return false
  }
  if (actor === '' || row.assignee === undefined || row.assignee === '') {
    return true
  }
  return row.assignee === actor
}

const beadsConnector: Connector = {
  name: 'beads',
  tasks: (ctx) => taskStore(ctx.dir),
  hooks: () => ({
    sessionStart(ctx) {
      try {
        const ready = taskStore(ctx.dir)
          .ready()
          .slice(0, 8)
          .map((r) => `  ${r.id} ${shortTitle(r.title)}`.trimEnd())
        return ready.length > 0 ? [`bd ready:\n${ready.join('\n')}`] : []
      } catch {
        return []
      }
    },
    parallelWork(ctx) {
      try {
        // other sessions' live work — own claims are already this
        // session's business, naming them again would be a false nudge.
        // "Own" is verified: a marker id whose claim was refused is
        // foreign work — the exact collision this nudge exists for.
        const mine = sessionTaskClaims(ctx)
        const me = bdActor(ctx.dir)
        const claimed = taskStore(ctx.dir)
          .list({ status: 'in_progress' })
          .filter((r) => !isOwnClaim(r, mine, me))
          .slice(0, 5)
          .map((r) => `${r.id} ${shortTitle(r.title)}`.trim())
        return claimed.length > 0 ? [`claimed beads: ${claimed.join(', ')}`] : []
      } catch {
        return []
      }
    },
    stopGate(ctx) {
      try {
        const claimed = taskStore(ctx.dir).list({ status: 'in_progress' })
        if (claimed.length === 0) {
          return []
        }
        // foreign claims are ambient — the session can't close beads it
        // doesn't own, so they stay passive context. Ownership is the
        // store's assignee, not the marker: a refused claim still arms
        // the id, and a bead held by another actor is never ours to close
        const mine = sessionTaskClaims(ctx)
        const me = bdActor(ctx.dir)
        const own = claimed.filter((r) => isOwnClaim(r, mine, me))
        const foreign = claimed.filter((r) => !isOwnClaim(r, mine, me))
        const fmt = (r: { id: string; title?: string }): string =>
          `${r.id} ${shortTitle(r.title)}`.trim()
        const out: GateContribution[] = []
        if (own.length > 0) {
          out.push({
            aspect: 'task',
            block:
              `bro: claimed beads open: ${own.slice(0, 5).map(fmt).join(', ')} — ` +
              'close (`bd close <id>`) or release the claim before stopping',
          })
        }
        if (foreign.length > 0) {
          out.push({
            aspect: 'task',
            passive: `bro: claimed beads open: ${foreign.slice(0, 5).map(fmt).join(', ')}`,
          })
        }
        return out
      } catch {
        return []
      }
    },
  }),
}

// --- registry ------------------------------------------------------------------

const registry: Connector[] = [beadsConnector]

/** Plugin connectors register here (BroPlugin.connectors). Duplicate
 *  names are skipped — a plugin cannot shadow a built-in system. */
export function registerConnector(c: Connector): void {
  if (registry.some((x) => x.name === c.name)) {
    console.error(`warning: connector "${c.name}" already registered — skipped`)
    return
  }
  registry.push(c)
}

export function connectors(): readonly Connector[] {
  return registry
}

// --- resolution ----------------------------------------------------------------

function remoteUrl(dir: string): string | undefined {
  const r = gitTry(['-C', dir, 'remote', 'get-url', 'origin'])
  return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : undefined
}

export interface FacadeOpts {
  /** Explicit connector name — wins over config and auto-detect. */
  connector?: string
  /** facade → connector precedence from bro.config.json `connectors`. */
  prefer?: Record<string, string>
}

/** Auto-detect picks memoized per (kind, dir, remote URL, registry
 *  shape) — a command resolves the same facade twice (auth gate, then
 *  the facade itself); the memo keeps the ambiguity warning single.
 *  The URL sits in the key so a mid-process `git remote set-url`
 *  re-resolves instead of serving a stale pick; registry length does
 *  the same for a later registerConnector. */
const pickMemo = new Map<string, Connector>()

/** Ambiguity warning policy — a non-default provider silently winning
 *  (dir/remote claim) deserves a pin hint, as does a bare fallback when
 *  NO provider declares a matcher. When a matchDir exists but none
 *  claimed, registry-first is the designed default (specs: bare repo →
 *  native), not ambiguity the user should be nagged about. */
function warnIfAmbiguous(
  kind: string,
  providers: Connector[],
  pick: Connector,
  remoteMatched: boolean
): void {
  if (remoteMatched || providers.length <= 1) {
    return
  }
  const designedDefault =
    pick === providers[0] && providers.some((c) => c.matchDir !== undefined)
  if (designedDefault) {
    return
  }
  console.error(
    `warning: ${providers.map((c) => c.name).join(', ')} all provide "${kind}" ` +
      `— using ${pick.name}; set connectors.${kind} in bro.config.json`
  )
}

/** The connector chosen to serve `kind` — shared by facade() and auth
 *  probing so both resolve through the same precedence. */
function pickConnector<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts
): Connector {
  const providers = registry.filter((c) => typeof c[kind as keyof Connector] === 'function')
  const named = opts.connector ?? opts.prefer?.[kind]
  if (named !== undefined) {
    const pick = providers.find((c) => c.name === named)
    if (!pick) {
      throw new Error(`connector "${named}" does not provide "${kind}"`)
    }
    return pick
  }
  const url = remoteUrl(ctx.dir)
  const key = `${kind}\0${ctx.dir}\0${url ?? ''}\0${registry.length}`
  const memo = pickMemo.get(key)
  if (memo !== undefined) {
    return memo
  }
  const remote = url === undefined ? undefined : providers.find((c) => c.matchRemote?.(url))
  // no remote claim → project-layout match (specs: .specify/, openspec/)
  const dir = remote === undefined ? providers.find((c) => c.matchDir?.(ctx.dir)) : undefined
  const pick = remote ?? dir ?? providers[0]
  if (!pick) {
    throw new Error(`no connector provides "${kind}"`)
  }
  warnIfAmbiguous(kind, providers, pick, remote !== undefined)
  pickMemo.set(key, pick)
  return pick
}

/** Resolve the facade a command needs. Throws when nothing provides it —
 *  callers that probe rather than require should catch or pre-check
 *  `connectors()`. */
export function facade<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts = {}
): FacadeMap[K] {
  const pick = pickConnector(kind, ctx, opts)
  const provides = pick[kind as keyof Connector] as (ctx: ConnectorCtx) => unknown
  return provides(ctx) as FacadeMap[K]
}

/** The name of the connector facade() would pick for `kind` — same
 *  precedence, for callers that need the serving connector's identity
 *  (e.g. "is the configured fallback the same connector as the
 *  primary?"). */
export function facadeName<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts = {}
): string {
  return pickConnector(kind, ctx, opts).name
}

/** The serving connector's auth probe — null when ready, else the
 *  remediation line. Resolution failures surface as the message: a
 *  missing provider is as unusable as a missing credential. */
export function facadeAuth<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts = {}
): string | null {
  try {
    const c = pickConnector(kind, ctx, opts)
    // the sync signature is a convention plugins can violate — a Promise
    // is truthy, sails past ?? null, and prints as "[object Promise]",
    // so check the shape and name the plugin instead
    const r: unknown = c.auth?.(ctx)
    if (r === null || r === undefined) {
      return null
    }
    if (typeof r !== 'string') {
      if (r instanceof Promise) {
        // swallow rejections — the diagnostic already carries the bug
        r.catch(() => {})
      }
      const got = r instanceof Promise ? 'a Promise' : typeof r
      return `connector "${c.name}": auth probe must be sync — got ${got}`
    }
    return r
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Hard auth gate for commands — exits(1) with the remediation line when
 *  the resolved connector isn't usable. */
export function ensureAuth<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts = {}
): void {
  const msg = facadeAuth(kind, ctx, opts)
  if (msg) {
    console.error(`error: ${msg}`)
    process.exit(1)
  }
}

/** facade('reviews') bound to a dir — the common resolution path for
 *  review-host commands (act/debt/hooks). */
export function reviewHost(
  dir: string = process.cwd(),
  prefer?: Record<string, string>
): ReviewFacade {
  return facade('reviews', { dir }, { prefer })
}

/** facade('specs') bound to a dir — the SDD tool this project runs. */
export function specStore(
  dir: string = process.cwd(),
  prefer?: Record<string, string>
): SpecStore {
  return facade('specs', { dir }, { prefer })
}

/** Every registered connector's hook probes — hooks collect, never pick:
 *  each system reports its own ambient state. */
export function connectorHooks(ctx: ConnectorCtx): ConnectorHooks[] {
  const out: ConnectorHooks[] = []
  for (const c of registry) {
    try {
      const h = c.hooks?.(ctx)
      if (h) {
        out.push(h)
      }
    } catch {
      // a wedged connector contributes no probes — fail-open
    }
  }
  return out
}

/** Per-probe budget — a hung connector (dead network, wedged CLI) must
 *  not stall the whole hook. Racing the probe means the output goes out
 *  on time even if a spawned child lingers. */
export const PROBE_TIMEOUT_MS = 4_000

/** Sentinel fallback — lets a collector tell "probe timed out" apart
 *  from a probe that genuinely answered `undefined`. */
const PROBE_TIMED_OUT: unique symbol = Symbol('probe-timed-out')

async function probeWithTimeout<T>(p: MaybePromise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([Promise.resolve(p), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** A connector sweep's lines plus whether every probe answered inside
 *  its budget — `settled: false` means a timeout or throw hid state, so
 *  empty `lines` reads "unknown", not "nothing to report". */
export interface ProbeResult {
  lines: string[]
  settled: boolean
}

/** Collect a line-producing probe across all connectors — fail-open
 *  per connector, one wedged system must not starve the rest. A probe
 *  that times out or throws still contributes nothing, but flips
 *  `settled` so the caller can retry instead of caching the miss. */
async function collectLines(
  ctx: ConnectorCtx,
  probe: (h: ConnectorHooks) => MaybePromise<string[] | undefined>
): Promise<ProbeResult> {
  const out: string[] = []
  let settled = true
  for (const h of connectorHooks(ctx)) {
    try {
      const r = await probeWithTimeout<string[] | undefined | typeof PROBE_TIMED_OUT>(
        probe(h),
        PROBE_TIMED_OUT
      )
      if (r === PROBE_TIMED_OUT) {
        settled = false
        continue
      }
      out.push(...(r ?? []))
    } catch {
      // fail-open output, but the sweep did not settle
      settled = false
    }
  }
  return { lines: out, settled }
}

/** Collect session-start context lines from all connectors. */
export async function sessionStartLines(ctx: ConnectorCtx): Promise<string[]> {
  return (await sessionStartProbe(ctx)).lines
}

/** Session-start lines plus the settle flag — rehydrate marks are only
 *  honest when every probe answered. */
export function sessionStartProbe(ctx: ConnectorCtx): Promise<ProbeResult> {
  return collectLines(ctx, (h) => h.sessionStart?.(ctx))
}

/** Collect parallel-work signals from all connectors. */
export async function parallelWorkLines(ctx: ConnectorCtx): Promise<string[]> {
  return (await parallelWorkProbe(ctx)).lines
}

/** Parallel-work lines plus the settle flag. */
export function parallelWorkProbe(ctx: ConnectorCtx): Promise<ProbeResult> {
  return collectLines(ctx, (h) => h.parallelWork?.(ctx))
}

/** Collect prompt-submit context from all connectors. */
export async function promptContextLines(ctx: ConnectorCtx, prompt: string): Promise<string[]> {
  return (await collectLines(ctx, (h) => h.promptSubmit?.(ctx, prompt))).lines
}

/** Collect post-tool context lines from all connectors — mailbox
 *  drains and other per-event probes. */
export async function postToolLines(ctx: ConnectorCtx): Promise<string[]> {
  return (await collectLines(ctx, (h) => h.postTool?.(ctx))).lines
}

/** Collect stop-gate contributions from all connectors — the caller
 *  applies the session-arming policy to each. */
export async function stopGateContributions(
  ctx: ConnectorCtx
): Promise<GateContribution[]> {
  const out: GateContribution[] = []
  for (const h of connectorHooks(ctx)) {
    try {
      out.push(...((await probeWithTimeout(h.stopGate?.(ctx), undefined)) ?? []))
    } catch {
      // fail-open
    }
  }
  return out
}

/** Collect pre-tool verdicts from all connectors — the caller decides
 *  whether a block or an input override wins. */
export async function preToolVerdicts(
  ctx: ConnectorCtx,
  tool: string,
  input: Record<string, unknown>
): Promise<PreToolVerdict[]> {
  // parallel probes, registry-order merge — a wedged connector can't
  // stall the queue and verdict order stays the config's
  const verdicts = await Promise.all(
    connectorHooks(ctx).map(async (h) => {
      try {
        return (await probeWithTimeout(h.preTool?.(ctx, { tool, input }), undefined)) ?? []
      } catch {
        return [] // fail-open
      }
    })
  )
  return verdicts.flat()
}
