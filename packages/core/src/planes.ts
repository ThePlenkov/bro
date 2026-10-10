/**
 * Plane descriptors — the transport-agnostic facade contract
 * (specs/bro-9rls.1.md). Core holds the contract, the row types, and
 * the registry; adapters live in `packages/cli/src/planes/` because the
 * machinery they project lives in cli.
 *
 * Facades (connectors.ts) resolve which *system* serves a capability;
 * planes declare what *bro* serves a client. Transports (REST, SSE,
 * MCP) are generated projections of this catalog — a transport carries
 * no semantics of its own, and a row/verb that differs by transport is
 * a descriptor bug, not a feature.
 *
 * Vocabulary rule: plane rows carry plane nouns only. A field named
 * `bead`, `jira`, `bd`, `glab` is a spec violation; backend identity
 * survives only as a `backend: string` *value* where provenance matters.
 */

/** Every row exposes a stable domain key — task id, agentId, mol id,
 *  `{gen}:{seq}`, thread_id — so `get`/`exec` refs match across
 *  transports and across broker restarts. */
export interface PlaneRow {
  id: string
}

/** list() filter — status/limit are the common spine; planes may add
 *  their own keys via the index signature. */
export interface PlaneFilter {
  status?: string
  limit?: number
  [key: string]: unknown
}

/** Client bug — undeclared verb/read name, malformed args. */
export class PlaneVerbError extends Error {
  override name = 'PlaneVerbError'
  constructor(
    public readonly plane: string,
    verb: string,
    detail?: string
  ) {
    const suffix = detail === undefined ? '' : `: ${detail}`
    super(`${plane}.${verb}${suffix}`)
  }
}

/** The backend can't serve this read right now — degraded, never a
 *  fake empty list. */
export class PlaneUnavailable extends Error {
  override name = 'PlaneUnavailable'
  constructor(
    public readonly plane: string,
    detail: string
  ) {
    super(`${plane}: ${detail}`)
  }
}

/** JSON Schema object describing one read's args — surfaced verbatim as
 *  tool inputSchema / route param docs by transports. */
export type PlaneArgSchema = Record<string, unknown>

export interface PlaneDescriptor {
  /** plane name — the transport URL/tool namespace */
  name: string
  /** named read projections beyond list/get ('ready', 'next', 'tail',
   *  'stats', 'summary', …). Every transport enumerates them: REST
   *  serves GET /<plane>/<read>, MCP emits bro_<plane>_<read>. A name
   *  not declared here cannot be a tool — generation, not convention. */
  reads: string[]
  /** declared verbs, plane vocabulary only. Declared ≠ exposed: v1
   *  transports serve reads only while write authz is undesigned. */
  verbs: string[]
  /** JSON-schema arg shapes per named read and for 'list' — transports
   *  surface them as-is. Absent → a permissive object schema. */
  readArgs?: Record<string, PlaneArgSchema>
  /** live-evaluated — presence means probed-capable, not configured.
   *  `read: false` hides every tool for the plane. */
  capabilities(): Promise<Record<string, boolean>>
  list(filter?: PlaneFilter): Promise<PlaneRow[]>
  get(ref: string): Promise<PlaneRow | undefined>
  /** a declared named read — every entry in `reads` resolves here */
  read(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** throws PlaneVerbError — client bug (bad args) vs
   *  PlaneUnavailable — the backend can't serve it now */
  exec(verb: string, args: Record<string, unknown>): Promise<PlaneRow | void>
}

// ---------------------------------------------------------------------------
// row types — the public vocabulary each plane emits
// ---------------------------------------------------------------------------

/** work — one tracked work item (the task store's row, plane-renamed). */
export interface WorkItem extends PlaneRow {
  title?: string
  status?: string
  assignee?: string
  type?: string
  priority?: number
  labels?: string[]
  parent?: string
  close_reason?: string
}

/** agents — one running/registered worker. */
export interface Worker extends PlaneRow {
  backend: string
  state: string
  step?: string
  cause?: string
  pid?: number
  worktree?: string
  provider?: string
  model?: string
}

/** queue — one molecule/run with its DAG posture. */
export interface Run extends PlaneRow {
  title: string
  status: string
  /** nextStep()'s verdict: 'step' | 'gate' | 'blocked' | 'complete' |
   *  'error' when the mol's own read failed */
  state: string
  error?: string
  ready: string[]
  gates: string[]
  inProgress: string[]
  blocked: string[]
  stuck: string[]
  /** get() detail — the DAG steps (same shape `convoy next` prints) and
   *  the closed-dependency handoff for the current step. */
  steps?: { id: string; title: string; state: string; kind: string; blockedBy: string[] }[]
  inputs?: { id: string; title: string; reason: string }[]
}

/** gates — one PR's review-gate posture. */
export interface Gate extends PlaneRow {
  pr: number
  url: string
  headRef?: string
  /** 'GREEN' | 'BLOCKED' — the exit gate's verdict */
  state: string
  openThreads: number
  ciPending: number
  ciFailing: number
  reviewersPending: number
  sastPending: number
  blockers: string[]
  alerts: string[]
}

/** events — one envelope off the bus ring or notify mailbox. `gen`
 *  is the broker's per-run token (a string — the `{gen}:{seq}` cursor),
 *  `payload` mirrors the envelope's opaque `unknown`. */
export interface EventRow extends PlaneRow {
  topic: string
  kind: string
  ts: string
  seq?: number
  gen?: string
  key?: string
  to?: string
  source?: string
  cause?: string
  ref?: string
  payload?: unknown
  locator?: string
  /** 'bus' | 'mailbox' — which store the row came from */
  origin: string
}

/** lifecycle — one durable journal row off `<git-common>/bro/
 *  events.jsonl` (specs/telemetry/bro-ub91h.md). `id` is `life:<n>` —
 *  the line position in the current file; compaction shifts ids the
 *  same way a truncated tail reports `gapped`. `origin` is always
 *  'lifecycle'. */
export interface LifecycleRow extends PlaneRow {
  ts: string
  /** the transition verb — open string on the read side so a journal
   *  carrying newer kinds still parses */
  kind: string
  bead?: string
  pr?: number
  actor: string
  session: string
  from?: string
  to?: string
  detail?: Record<string, unknown>
  /** 1-based line position in the current file — the append order */
  seq: number
  origin: string
}

/** judge — one journal row (verdict or observed disposition). */
export interface VerdictRow extends PlaneRow {
  ts: string
  kind: string
  subject: { pr?: number; threadId?: string; headSha?: string; commentSha?: string }
  outcome?: string
  model?: string
  lowConfidence?: string[]
}

/** debt — one harvested review-debt finding. */
export interface Finding extends PlaneRow {
  pr: number
  url: string
  status: string
  priority: string
  needs?: string
  path?: string
  line?: number | null
  author?: string
  area?: string
  preview?: string
  harvested_at?: string
  fix_pr?: number | null
  fixed_at?: string | null
}

/** learn — one stored lesson. */
export interface LessonRow extends PlaneRow {
  ts?: string
  /** the rule — imperative, quotable as one line */
  summary?: string
  /** hook events the lesson fires on */
  triggers?: string[]
  body?: string
  source?: string
  confidence?: string
}

// ---------------------------------------------------------------------------
// registry — parallel to registerConnector: adapters register a factory,
// planes(dir) builds the catalog for one repo
// ---------------------------------------------------------------------------

export interface PlaneCtx {
  /** repo dir — the worktree `bro mcp`/`bro serve` runs for */
  dir: string
  /** connectors.* pins — backend selection rides the user's configured
   *  precedence; a plane never picks a vendor itself */
  connectors: Record<string, string>
}

export type PlaneFactory = (ctx: PlaneCtx) => PlaneDescriptor

const factories = new Map<string, PlaneFactory>()

/** Built-ins and plugins register here; duplicate names are skipped —
 *  a plugin cannot shadow a built-in plane. */
export function registerPlane(name: string, factory: PlaneFactory): void {
  if (factories.has(name)) {
    return
  }
  factories.set(name, factory)
}

/** test seam — registration is module-load state, tests must reset it */
export function clearPlanes(): void {
  factories.clear()
}

export function planeNames(): string[] {
  return [...factories.keys()]
}

/** A factory that throws must not take the catalog down — the plane
 *  reports itself unavailable instead of vanishing silently. */
function stubPlane(name: string, err: unknown): PlaneDescriptor {
  const detail = err instanceof Error ? err.message : String(err)
  return {
    name,
    reads: [],
    verbs: [],
    capabilities: async () => ({ read: false, error: true }),
    list: async () => {
      throw new PlaneUnavailable(name, `descriptor failed to build — ${detail}`)
    },
    get: async () => {
      throw new PlaneUnavailable(name, `descriptor failed to build — ${detail}`)
    },
    read: async () => {
      throw new PlaneUnavailable(name, `descriptor failed to build — ${detail}`)
    },
    exec: async () => {
      throw new PlaneUnavailable(name, `descriptor failed to build — ${detail}`)
    },
  }
}

/** The catalog for one repo — adapters declared via registerPlane, in
 *  registration order (the canonical order is the spec's). */
export function planes(dir: string, opts: { connectors?: Record<string, string> } = {}): PlaneDescriptor[] {
  const ctx: PlaneCtx = { dir, connectors: opts.connectors ?? {} }
  const out: PlaneDescriptor[] = []
  for (const [name, f] of factories) {
    try {
      out.push(f(ctx))
    } catch (err) {
      out.push(stubPlane(name, err))
    }
  }
  return out
}

/** v1 transports serve reads only — a declared-but-unwired verb throws
 *  PlaneUnavailable (the backend can't serve it here), an undeclared
 *  one throws PlaneVerbError (client bug). One helper keeps the split
 *  identical on every plane. */
export function verbsNotWired(
  plane: string,
  verbs: string[]
): (verb: string, args: Record<string, unknown>) => Promise<never> {
  return async (verb) => {
    if (!verbs.includes(verb)) {
      throw new PlaneVerbError(plane, verb, 'undeclared verb')
    }
    throw new PlaneUnavailable(
      plane,
      `verb '${verb}' is declared but not exposed — write authz (session ownership) is undesigned`
    )
  }
}
