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
import { gitTry } from './git.ts'
import type { ReviewFacade } from './review.ts'
import type { TaskStore } from './tasks.ts'
import { taskStore } from './tasks.ts'

export interface ConnectorCtx {
  /** Working dir — repo root for project-scoped facades, the resolved
   *  global dir for user-level ones (same contract as taskStore(dir)). */
  dir: string
}

/** Capability → facade type. Optional on Connector; required here once
 *  the facade exists. `findings`, `sast` join when their first real
 *  consumer lands. */
export interface FacadeMap {
  tasks: TaskStore
  reviews: ReviewFacade
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
  /** Stop-gate contributions — non-empty `block` means the session has
   *  unfinished business in this system. */
  stopGate?(ctx: ConnectorCtx): MaybePromise<GateContribution[]>
}

export interface Connector {
  readonly name: string
  /** Remote-URL matcher — the connector claims hosts it can serve
   *  (github.com, gitlab.*, a self-hosted domain). Drives facade
   *  auto-detect ahead of registry order. */
  matchRemote?(url: string): boolean
  tasks?(ctx: ConnectorCtx): TaskStore
  reviews?(ctx: ConnectorCtx): ReviewFacade
  hooks?(ctx: ConnectorCtx): ConnectorHooks
}

// --- built-in: beads -----------------------------------------------------------

const shortTitle = (t: string | undefined): string => {
  const flat = (t ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
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
        const claimed = taskStore(ctx.dir)
          .list({ status: 'in_progress' })
          .slice(0, 5)
          .map((r) => `${r.id} ${shortTitle(r.title)}`.trim())
        return claimed.length > 0 ? [`claimed beads: ${claimed.join(', ')}`] : []
      } catch {
        return []
      }
    },
    stopGate(ctx) {
      try {
        const claimed = taskStore(ctx.dir)
          .list({ status: 'in_progress' })
          .slice(0, 5)
          .map((r) => `${r.id} ${shortTitle(r.title)}`.trim())
        if (claimed.length === 0) {
          return []
        }
        const list = claimed.join(', ')
        return [
          {
            aspect: 'work',
            block:
              `bro: claimed beads open: ${list} — ` +
              'close (`bd close <id>`) or release the claim before stopping',
            passive: `bro: claimed beads open: ${list}`,
          },
        ]
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

/** Resolve the facade a command needs. Throws when nothing provides it —
 *  callers that probe rather than require should catch or pre-check
 *  `connectors()`. */
export function facade<K extends keyof FacadeMap>(
  kind: K,
  ctx: ConnectorCtx,
  opts: FacadeOpts = {}
): FacadeMap[K] {
  const provides = (c: Connector): ((ctx: ConnectorCtx) => unknown) | undefined =>
    c[kind as keyof Connector] as ((ctx: ConnectorCtx) => unknown) | undefined
  const providers = registry.filter((c) => typeof provides(c) === 'function')
  const named = opts.connector ?? opts.prefer?.[kind]
  let pick: Connector | undefined
  if (named !== undefined) {
    pick = providers.find((c) => c.name === named)
    if (!pick) {
      throw new Error(`connector "${named}" does not provide "${kind}"`)
    }
  } else {
    const url = remoteUrl(ctx.dir)
    const remote = url === undefined ? undefined : providers.find((c) => c.matchRemote?.(url))
    pick = remote ?? providers[0]
    if (!pick) {
      throw new Error(`no connector provides "${kind}"`)
    }
    if (remote === undefined && providers.length > 1) {
      console.error(
        `warning: ${providers.map((c) => c.name).join(', ')} all provide "${kind}" ` +
          `— using ${pick.name}; set connectors.${kind} in bro.config.json`
      )
    }
  }
  return provides(pick)!(ctx) as FacadeMap[K]
}

/** facade('reviews') bound to a dir — the common resolution path for
 *  review-host commands (act/debt/hooks). */
export function reviewHost(
  dir: string = process.cwd(),
  prefer?: Record<string, string>
): ReviewFacade {
  return facade('reviews', { dir }, { prefer })
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

/** Collect a line-producing probe across all connectors — fail-open
 *  per connector, one wedged system must not starve the rest. */
async function collectLines(
  ctx: ConnectorCtx,
  probe: (h: ConnectorHooks) => MaybePromise<string[] | undefined>
): Promise<string[]> {
  const out: string[] = []
  for (const h of connectorHooks(ctx)) {
    try {
      out.push(...((await probe(h)) ?? []))
    } catch {
      // fail-open
    }
  }
  return out
}

/** Collect session-start context lines from all connectors. */
export function sessionStartLines(ctx: ConnectorCtx): Promise<string[]> {
  return collectLines(ctx, (h) => h.sessionStart?.(ctx))
}

/** Collect parallel-work signals from all connectors. */
export function parallelWorkLines(ctx: ConnectorCtx): Promise<string[]> {
  return collectLines(ctx, (h) => h.parallelWork?.(ctx))
}

/** Collect prompt-submit context from all connectors. */
export function promptContextLines(ctx: ConnectorCtx, prompt: string): Promise<string[]> {
  return collectLines(ctx, (h) => h.promptSubmit?.(ctx, prompt))
}

/** Collect stop-gate contributions from all connectors — the caller
 *  applies the session-arming policy to each. */
export async function stopGateContributions(
  ctx: ConnectorCtx
): Promise<GateContribution[]> {
  const out: GateContribution[] = []
  for (const h of connectorHooks(ctx)) {
    try {
      out.push(...((await h.stopGate?.(ctx)) ?? []))
    } catch {
      // fail-open
    }
  }
  return out
}
