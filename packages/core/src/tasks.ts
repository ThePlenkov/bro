/**
 * TaskStore — the typed issue-level surface every bro package consumes.
 * Workflow code never calls bd()/bdJson() for issue ops; it asks for
 * `taskStore(dir)` — or the configured facade — and gets a narrow
 * contract. Swapping the backend means reimplementing this interface,
 * not every command.
 *
 * Scope is a construction concern: `dir` is the store's working dir —
 * the repo root for project beads, the resolved global dir for
 * user-level ones. The beads CLI routes by cwd; the TaskStore doesn't
 * care which store it fronts. `taskStoreAt(beadsDir)` is the second
 * routing mode — BEADS_DIR pinning for the shared-claim plane.
 *
 * Relations speak domain vocabulary — `parent | blocked | related |
 * discovered | tracks` — never backend-native names. Connectors map to
 * their own dialects (`parent-child`, `blocks`, `discovered-from`),
 * and edge rows come back normalized to the generic names.
 *
 * Optional members (`sync`, `dataDir`, `init`, `slot`) advertise
 * capabilities — absence is honest, callers degrade rather than fake.
 *
 * Deliberately absent — beads subsystems that aren't tasks:
 * mol/wisp (molecules), provenance (evidence), kv/docs, config.
 * Those keep calling bd() until they get doc types.
 */
import { join } from 'node:path'
import { bd, BdCompatError, bdAt, BD_NO_STORE, bdJson, bdJsonAsync, bdTry, bdTryAsync, isBdNotFound } from './bd.ts'
import { gitTry } from './git.ts'

/** Resolved probe results per dir — hook surfaces ask for the actor
 *  several times per event in one process, and each probe is a sync
 *  bd+git shell-out. Processes that call this are short-lived hooks,
 *  so a stale entry is not a real concern. Env stays outside the
 *  cache: it wins unconditionally and is read fresh every call. */
const actorCache = new Map<string, string>()

/** The identity `bd … --claim` writes to assignee — bd's actor chain
 *  (BEADS_ACTOR → BD_ACTOR → config `actor` → git user.name → $USER),
 *  minus the --actor flag no bro call passes. '' when nothing resolves;
 *  ownership checks treat that as unverifiable, never as a match. */
export function bdActor(dir: string): string {
  const env = process.env.BEADS_ACTOR?.trim() || process.env.BD_ACTOR?.trim() || ''
  if (env !== '') {
    return env
  }
  let actor = actorCache.get(dir)
  if (actor === undefined) {
    actor = probeActor(dir)
    actorCache.set(dir, actor)
  }
  return actor
}

/** The `config get actor` output line → actor name — 'actor = name'
 *  takes the value side; '(not set)'/empty lines fall through. */
function parseActorLine(line: string): string {
  if (line === '' || /not set/i.test(line)) {
    return ''
  }
  const eq = line.indexOf('=')
  return (eq >= 0 ? line.slice(eq + 1) : line).trim().replace(/^['"]|['"]$/g, '')
}

function probeActor(dir: string): string {
  // 'actor = name' — take the value side; 'actor (not set…)' falls through
  const cfg = bdTry(['config', 'get', 'actor'], 3_000, dir)
  const line = cfg.code === 0 ? (cfg.out.trim().split('\n').pop()?.trim() ?? '') : ''
  const v = parseActorLine(line)
  if (v !== '') {
    return v
  }
  const git = gitTry(['-C', dir, 'config', 'user.name'])
  if (git.code === 0 && git.out.trim() !== '') {
    return git.out.trim()
  }
  return process.env.USER?.trim() ?? ''
}

/** bdActor for an env-pinned store — same resolution chain, probed
 *  through bdAt so the shared-store claim plane resolves the actor the
 *  pin's store would write. */
function bdActorAt(beadsDir: string): string {
  const env = process.env.BEADS_ACTOR?.trim() || process.env.BD_ACTOR?.trim() || ''
  if (env !== '') {
    return env
  }
  const key = `at:${beadsDir}`
  const cached = actorCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const cfg = bdAt(beadsDir, ['config', 'get', 'actor'], 3_000)
  const line = cfg.code === 0 ? (cfg.out.trim().split('\n').pop()?.trim() ?? '') : ''
  const configActor = parseActorLine(line)
  if (configActor !== '') {
    // only the store's own config is beadsDir-keyed — the git/USER
    // fallback reads the CALLER's cwd, so caching it would lend one
    // caller's identity to every later caller of the pinned store
    actorCache.set(key, configActor)
    return configActor
  }
  const git = gitTry(['config', 'user.name'])
  return git.code === 0 && git.out.trim() !== ''
    ? git.out.trim()
    : (process.env.USER?.trim() ?? '')
}

/** Async bdActor — same resolution chain, but the bd probe doesn't
 *  block the event loop. Hook sweeps await this; the sync twin stays
 *  for command paths where a Promise would just be awaited anyway. */
export async function bdActorAsync(dir: string): Promise<string> {
  const env = process.env.BEADS_ACTOR?.trim() || process.env.BD_ACTOR?.trim() || ''
  if (env !== '') {
    return env
  }
  const cached = actorCache.get(dir)
  if (cached !== undefined) {
    return cached
  }
  const cfg = await bdTryAsync(['config', 'get', 'actor'], 3_000, dir)
  const line = cfg.code === 0 ? (cfg.out.trim().split('\n').pop()?.trim() ?? '') : ''
  let actor = parseActorLine(line)
  if (actor === '') {
    const git = gitTry(['-C', dir, 'config', 'user.name'])
    actor =
      git.code === 0 && git.out.trim() !== ''
        ? git.out.trim()
        : (process.env.USER?.trim() ?? '')
  }
  actorCache.set(dir, actor)
  return actor
}

/** The row shape the task backend returns — fields optional, extras
 *  pass through so callers can read backend-specific data without the
 *  contract widening. No index signature: concrete row types (DrillRow,
 *  BeadRow, …) must satisfy this structurally without declaring one. */
export interface TaskRow {
  id: string
  title?: string
  status?: string
  /** claim holder — the actor `claim()` wrote; ownership checks read it */
  assignee?: string
  issue_type?: string
  priority?: number
  labels?: string[]
  description?: string
  notes?: string
  parent?: string
  external_ref?: string | null
  close_reason?: string
  /** close timestamp — `bd list` emits it on closed rows */
  closed_at?: string
  /** backend-level ephemeral/wisp flag — sweep's harvest set skips it */
  ephemeral?: boolean
  metadata?: Record<string, unknown> | null
}

export interface TaskFilter {
  status?: string
  labels?: string[]
  excludeLabels?: string[]
  /** include closed/done rows */
  all?: boolean
  /** row cap — 0 or negative means no cap (bd's own `-n 0` convention);
   *  remote connectors honor the same reading inside their fetch cap */
  limit?: number
  type?: string
}

export interface TaskInput {
  title: string
  description?: string
  type?: string
  priority?: number
  labels?: string[]
  /** dep specs — '<rel>:<id>' in the generic rel vocabulary */
  deps?: string[]
  /** parent id — shorthand for a parent dep edge */
  parent?: string
  noInheritLabels?: boolean
  externalRef?: string
  /** opaque backend metadata — serialized as JSON */
  metadata?: Record<string, unknown>
  /** backend-level ephemeral/wisp flag — no audit trail */
  ephemeral?: boolean
}

/** Generic relation names — the port's vocabulary, never backend
 *  dialect. `blocked` is directional: `link(a, b, 'blocked')` means
 *  "a is blocked by b" (bd `dep add a b`, github blocked-by). Unknown
 *  strings pass through so backend-specific rels still work. */
export type TaskRel =
  | 'parent'
  | 'blocked'
  | 'related'
  | 'discovered'
  | 'tracks'
  | (string & {})

/** Canonical dep edge — `issue_id` depends on `depends_on_id`; `type`
 *  is a generic rel name on the way out regardless of backend. */
export interface TaskDepEdge {
  issue_id: string
  depends_on_id: string
  type: string
}

export interface DepOpts {
  /** generic rel name — 'parent', 'blocked', 'related', 'discovered' */
  rel?: TaskRel
  /** 'down' = what the ids depend on; 'up' = what depends on them */
  direction?: 'up' | 'down' | (string & {})
}

/** generic rel → backend-native name. Native names pass through on
 *  input — mid-flight callers don't break — but nothing new should
 *  emit them. 'blocked-by' is a same-meaning alias some callers use. */
const REL_TO_NATIVE: Record<string, string> = {
  parent: 'parent-child',
  blocked: 'blocks',
  'blocked-by': 'blocks',
  related: 'related',
  discovered: 'discovered-from',
  tracks: 'tracks',
}
const REL_FROM_NATIVE: Record<string, string> = {
  'parent-child': 'parent',
  blocks: 'blocked',
  'blocked-by': 'blocked',
  related: 'related',
  'discovered-from': 'discovered',
  tracks: 'tracks',
}

/** The backend-native dep-type name for a generic rel — beads and the
 *  remote connectors share this table; unknown names pass through. */
export function nativeTaskRel(rel: string): string {
  return REL_TO_NATIVE[rel] ?? rel
}

/** The generic rel for a backend-native dep type — emitted edges and
 *  filter values normalize through it, so a caller never sees
 *  'parent-child'. Unknown names pass through. */
export function canonicalTaskRel(type: string): string {
  return REL_FROM_NATIVE[type] ?? type
}

/** A cross-session coordination slot on the store — 'merge' is the
 *  merge critical section. `unavailable` is the fail-open verdict:
 *  a dead store coordinates nothing and must not gate the work. */
export type SlotAcquire =
  | { kind: 'acquired' }
  | { kind: 'held'; holder: string }
  | { kind: 'unavailable' }

export interface TaskSlot {
  acquire(): SlotAcquire
  /** Best-effort — a wedged store leaves the slot held; implementors
   *  report on stderr rather than throwing over released work. */
  release(): void
  /** Current holder for context surfaces, or null when free/absent. */
  holder(): string | null
}

/** The bead→native-item projection's outcome (spec
 *  specs/backends/bro-z2z7f). `item` is the tracker's own row — its
 *  `id`/`external_ref` are the native ref the caller persists back on
 *  the source row as the dedup map. */
export interface PublishResult {
  item: TaskRow
  /** The epic's container ref (a milestone URL on github) when the
   *  projection joined one — the caller persists it on the epic row's
   *  external_ref. Absent when no container was needed. */
  epicRef?: string
  /** Set when the task's nonempty external_ref mapped to a MISSING item
   *  on this store — the connector re-published and the caller must
   *  overwrite the stale ref, or the next pass duplicates again.
   *  Foreign refs never carry it: they decline (undefined) instead. */
  replaceExternalRef?: boolean
}

export interface TaskStore {
  list<T extends TaskRow = TaskRow>(filter?: TaskFilter): T[]
  /** the claimable queue — backend applies its own ordering/filters */
  ready<T extends TaskRow = TaskRow>(filter?: TaskFilter): T[]
  get<T extends TaskRow = TaskRow>(id: string): T | undefined
  create<T extends TaskRow = TaskRow>(input: TaskInput): T
  /** field patch — keys map to `--<key> <value>` on the backend */
  update(id: string, patch: Record<string, string | number>): void
  /** atomic assignee + in_progress — throws when already claimed */
  claim(id: string): void
  /** the identity `claim()` writes to assignee — '' when unresolvable.
   *  Stores without a claim-actor concept omit it; ownership checks then
   *  keep the claim marker's word (fail-open) rather than disprove a
   *  foreign assignee against an identity space that isn't theirs. */
  actor?(): string
  reopen(id: string): void
  close(id: string, reason?: string): void
  /** hard delete — use close() for lifecycle transitions */
  remove(id: string): void
  note(id: string, text: string): void
  children<T extends TaskRow = TaskRow>(id: string): T[]
  /** dep edges touching `ids` — canonical TaskDepEdge rows with the
   *  `type` normalized to generic rel names. */
  deps<T = TaskDepEdge>(ids: string[], opts?: DepOpts): T[]
  /** hydrated neighbor rows of one id — the row-plane read for the
   *  same edges deps() reports as records. */
  neighbors<T extends TaskRow = TaskRow>(id: string, opts?: DepOpts): T[]
  /** wire `from`'s rel to `to` — `link(a, b, 'blocked')` = "a is
   *  blocked by b". Default 'related'. */
  link(from: string, to: string, rel?: TaskRel): void
  /** the store's id prefix — undefined when unset; THROWS when the
   *  probe fails (a shared db must fail closed, not reopen
   *  cross-repo claiming) */
  prefix(): string | undefined
  /** Backend replication — one full cycle (beads: `bd sync` dolt-refs
   *  pull+merge+push). Remote backends typically sync on write and
   *  omit this. Returns output for the caller to print; '' when
   *  nothing moved. Optional capability. */
  sync?(): string
  /** The backend's own data directory — beads answers `bd where`
   *  (pinned into spawned envs as BEADS_DIR); file-less backends omit
   *  it. Throws when the store can't answer. Optional capability. */
  dataDir?(): string | undefined
  /** Store provisioning — beads runs `bd init --non-interactive
   *  --init-if-missing [--prefix]`; remote backends omit it. Returns
   *  captured output for the caller to print. Optional capability. */
  init?(opts?: { prefix?: string }): string
  /** Named cross-session slot ('merge') — absent when the backend has
   *  no slot primitive; callers treat that as 'unavailable'. */
  slot?(name: string): TaskSlot | undefined
  /** The projection port — "materialize this source-store task as a
   *  native item" (spec specs/backends/bro-z2z7f). `task` is the
   *  SOURCE row; `epic` its epic parent when the caller resolved one
   *  (the connector picks the container mapping — github: epic →
   *  milestone). Returns the published item, or undefined when the
   *  task already projects elsewhere — a foreign external_ref is
   *  another system's map, never overwritten. Idempotent: an
   *  external_ref naming an item this store owns returns that item.
   *  Absent = no outward read-model; callers skip stamping entirely. */
  publish?(task: TaskRow, opts?: { epic?: TaskRow }): PublishResult | undefined
}

/** A parsed `--json` payload must be the shape the contract declares —
 *  valid JSON in a drifted shape (object envelope, bare strings) is a
 *  compat failure to name now, not a TypeError five calls later. */
function taskRows<T extends TaskRow>(v: unknown, cmd: string): T[] {
  if (!Array.isArray(v)) {
    throw new BdCompatError(
      `bd ${cmd} --json returned ${v === null ? 'null' : typeof v} — expected an array`
    )
  }
  for (const r of v) {
    if (typeof r !== 'object' || r === null || typeof (r as TaskRow).id !== 'string') {
      throw new BdCompatError(`bd ${cmd} --json rows lack a string \`id\` — output shape drifted`)
    }
  }
  return v as T[]
}

function taskRow(v: unknown, cmd: string): TaskRow | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (typeof v !== 'object' || typeof (v as TaskRow).id !== 'string') {
    throw new BdCompatError(`bd ${cmd} --json returned a non-row shape — output drifted`)
  }
  return v as TaskRow
}

/** `bd dep list --json` rows for one queried id answer hydrated
 *  neighbors (`dependency_type`); multi-id queries answer edge records
 *  (`issue_id`/`depends_on_id`/`type`). Detect by shape and emit
 *  canonical edges either way — for a hydrated row the queried id is
 *  the edge's other endpoint (direction decides which side). `type`
 *  comes back normalized to the generic rel vocabulary. */
function foldDepRows<T>(v: unknown, ids: string[], opts: DepOpts): T[] {
  if (!Array.isArray(v)) {
    throw new BdCompatError('bd dep list --json returned a non-array — output drifted')
  }
  const edges: TaskDepEdge[] = []
  for (const r of v) {
    const e = depRowToEdge(r, ids, opts)
    if (e !== undefined) {
      edges.push(e)
    }
  }
  return edges as T[]
}

function depRowToEdge(r: unknown, ids: string[], opts: DepOpts): TaskDepEdge | undefined {
  if (typeof r !== 'object' || r === null) {
    return undefined
  }
  const e = r as Record<string, unknown>
  if (typeof e.issue_id === 'string' && typeof e.depends_on_id === 'string') {
    return {
      issue_id: e.issue_id,
      depends_on_id: e.depends_on_id,
      type: canonicalTaskRel(typeof e.type === 'string' ? e.type : ''),
    }
  }
  if (ids.length !== 1 || typeof e.id !== 'string') {
    return undefined
  }
  const rel = typeof e.dependency_type === 'string' ? canonicalTaskRel(e.dependency_type) : ''
  return opts.direction === 'up'
    ? { issue_id: e.id, depends_on_id: ids[0]!, type: rel }
    : { issue_id: ids[0]!, depends_on_id: e.id, type: rel }
}

/** `bd dep list <id>` rows are hydrated neighbors — `dependency_type`
 *  names the edge. Normalized in place so callers read generic rels. */
function neighborRows<T extends TaskRow>(v: unknown): T[] {
  if (!Array.isArray(v)) {
    throw new BdCompatError('bd dep list --json returned a non-array — output drifted')
  }
  for (const r of v) {
    const e = r as { dependency_type?: unknown } | null
    if (e !== null && typeof e === 'object' && typeof e.dependency_type === 'string') {
      e.dependency_type = canonicalTaskRel(e.dependency_type)
    }
  }
  return v as T[]
}

function filterArgs(f: TaskFilter): string[] {
  const args: string[] = []
  if (f.status) args.push('--status', f.status)
  for (const l of f.labels ?? []) args.push('-l', l)
  for (const l of f.excludeLabels ?? []) args.push('--exclude-label', l)
  if (f.all) args.push('--all')
  if (f.limit !== undefined) args.push('-n', String(f.limit))
  if (f.type) args.push('--type', f.type)
  return args
}

function depArgs(ids: string[], opts: DepOpts): string[] {
  return [
    'dep',
    'list',
    ...ids,
    ...(opts.rel ? ['-t', nativeTaskRel(opts.rel)] : []),
    ...(opts.direction ? [`--direction=${opts.direction}`] : []),
  ]
}

function createArgs(i: TaskInput): string[] {
  const args = ['create', '--title', i.title]
  if (i.description) args.push('-d', i.description)
  if (i.type) args.push('-t', i.type)
  if (i.priority !== undefined) args.push('-p', String(i.priority))
  for (const l of i.labels ?? []) args.push('-l', l)
  if (i.deps?.length) {
    args.push('--deps', i.deps.map((d) => d.replace(/^([\w-]+):/, (m) => `${nativeTaskRel(m.slice(0, -1))}:`)).join(','))
  }
  if (i.parent) args.push('--parent', i.parent)
  if (i.ephemeral) args.push('--ephemeral')
  if (i.noInheritLabels) args.push('--no-inherit-labels')
  if (i.externalRef) args.push('--external-ref', i.externalRef)
  if (i.metadata) args.push('--metadata', JSON.stringify(i.metadata))
  return args
}

// --- merge-slot payloads (bd ≥1.2) ----------------------------------------------
//   check   → { available: boolean, holder: string|null, waiters }
//   acquire → { acquired: boolean, holder: string }

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `merge-slot acquire` output → slot outcome. Exported for tests —
 *  the shapes are the connector's contract with the backend. */
export function parseSlotAcquire(out: string): SlotAcquire {
  const body = parseJson(out)
  if (body?.acquired === true) {
    return { kind: 'acquired' }
  }
  // a held slot reports acquired:false + the current holder — distinguish
  // real contention from "no store here" by whether we got JSON at all;
  // an empty holder string is degenerate output, fail open instead of
  // refusing a merge with a nameless holder
  if (body && typeof body.holder === 'string' && body.holder.length > 0) {
    return { kind: 'held', holder: body.holder }
  }
  return { kind: 'unavailable' }
}

/** `merge-slot check` output → current holder or null. Exported for tests. */
export function parseSlotCheck(out: string): string | null {
  const body = parseJson(out)
  return body && body.available === false && typeof body.holder === 'string'
    ? body.holder
    : null
}

/** The exec triple the store is built over — cwd routing for
 *  taskStore(dir), BEADS_DIR pinning for taskStoreAt(beadsDir). `probe`
 *  is the non-throwing run for capabilities that must degrade;
 *  `storeDir` is the local `.beads` dir when one is addressed, for the
 *  replication leg's presence check. */
interface StoreExec {
  run(args: string[]): string
  json<T>(args: string[]): T
  probe(args: string[], ms: number): { code: number; out: string; err: string }
  actor(): string
  storeDir?: string
}

function makeStore(x: StoreExec): TaskStore {
  return {
    list: (f = {}) => taskRows(x.json(['list', '--json', ...filterArgs(f)]), 'list'),
    ready: (f = {}) => taskRows(x.json(['ready', ...filterArgs(f)]), 'ready'),
    get: (id) => {
      let r: TaskRow | TaskRow[]
      try {
        r = x.json<TaskRow | TaskRow[]>(['show', id])
      } catch (err) {
        // a missing id exits nonzero on bd — that miss is the contract's
        // `undefined`. Every other failure stays thrown: reporting a
        // dead backend as "absent" would mask a live row as gone
        if (isBdNotFound(err)) {
          return undefined as never
        }
        throw err
      }
      // bd show answers an array; empty/undefined = no such task
      return taskRow(Array.isArray(r) ? r[0] : r, 'show') as never
    },
    create: (i) => {
      const r = x.json<TaskRow | TaskRow[]>(createArgs(i))
      const row = taskRow(Array.isArray(r) ? r[0] : r, 'create')
      if (!row) {
        throw new BdCompatError('bd create returned no row — backend contract broken')
      }
      return row as never
    },
    update: (id, patch) => {
      const args = ['update', id]
      for (const [k, v] of Object.entries(patch)) {
        // boolean 'true' stays a bare flag (`--claim`-style); real
        // string values pass as --k v
        args.push(...(v === 'true' ? [`--${k}`] : [`--${k}`, String(v)]))
      }
      x.run(args)
    },
    claim: (id) => {
      x.run(['update', id, '--claim'])
    },
    actor: () => x.actor(),
    reopen: (id) => {
      x.run(['reopen', id])
    },
    close: (id, reason) => {
      x.run(['close', id, ...(reason ? ['--reason', reason] : [])])
    },
    remove: (id) => {
      x.run(['delete', id, '--force'])
    },
    note: (id, text) => {
      x.run(['note', id, text])
    },
    children: (id) => taskRows(x.json(['children', id]), 'children'),
    deps: (ids, opts = {}) => foldDepRows(x.json(depArgs(ids, opts)), ids, opts),
    neighbors: (id, opts = {}) => neighborRows(x.json(depArgs([id], opts))),
    link: (from, to, rel = 'related') => {
      // `dep add` rather than `link` — same edge, but dep add also
      // accepts `external:<project>:<id>` targets (mesh request wiring)
      x.run(['dep', 'add', from, to, '--type', nativeTaskRel(rel)])
    },
    prefix: () => {
      const probe = x.probe(['config', 'get', 'issue_prefix'], 15_000)
      if (probe.code !== 0) {
        throw new Error(`task store unreachable — ${probe.err || 'bd error'}`)
      }
      // output may be 'issue_prefix = bro' — take the value side
      const line = probe.out.trim().split('\n').pop()?.trim() ?? ''
      const v = parseActorLine(line)
      return v === '' ? undefined : v
    },
    sync: () => {
      // replicate whatever store bd itself routes to — bd finds the
      // project db through the git common dir, so a linked worktree
      // without its own .beads still shares a store with state to move.
      // bd's own verdicts ("no database", missing binary) mean nothing
      // to move; a stat of <cwd>/.beads would guess the routing wrong.
      if (x.storeDir === undefined) {
        return ''
      }
      const r = x.probe(['sync'], 120_000)
      if (r.code !== 0) {
        if (/ENOENT/.test(r.err) || BD_NO_STORE.test(r.err)) {
          return '' // no bd, or no routed store — state simply doesn't move
        }
        throw new Error(`task store sync failed — ${r.err || `bd exited ${r.code}`}`)
      }
      return r.out
    },
    dataDir: () => {
      const r = x.probe(['where', '--json'], 15_000)
      if (r.code !== 0) {
        throw new Error(`task store unreachable — ${r.err || 'bd error'}`)
      }
      try {
        const path = (JSON.parse(r.out) as { path?: unknown }).path
        return typeof path === 'string' && path !== '' ? path : undefined
      } catch {
        return undefined
      }
    },
    init: (opts = {}) => {
      const args = ['init', '--non-interactive', '--init-if-missing']
      if (opts.prefix) {
        args.push('--prefix', opts.prefix)
      }
      // dolt bootstrap can outlast the 15s default — and ENOENT (no bd
      // binary) must stay classifiable on the thrown error for the
      // store doctype's "install beads" diagnostic
      const r = x.probe(args, 120_000)
      if (r.code !== 0) {
        throw Object.assign(new Error(r.err || `bd init exited ${r.code}`), {
          code: /ENOENT/.test(r.err) ? 'ENOENT' : r.code,
        })
      }
      return r.out
    },
    slot: (name) => {
      if (name !== 'merge') {
        return undefined
      }
      return {
        acquire: () => {
          // slot bead may not exist yet in a fresh db — create is
          // idempotent, so a missing slot is not a failure path
          x.probe(['merge-slot', 'create'], 15_000)
          return parseSlotAcquire(x.probe(['merge-slot', 'acquire', '--json'], 15_000).out)
        },
        release: () => {
          const res = x.probe(['merge-slot', 'release', '--json'], 15_000)
          if (res.code !== 0) {
            console.error(
              `bro: merge-slot release failed (${res.err || `exit ${res.code}`}) — ` +
                'slot may stay held; recover with `bd merge-slot release`'
            )
          }
        },
        holder: () => {
          // hooks call this inline on every lifecycle event — a wedged
          // store must cost ~seconds, not the default 15s budget
          const res = x.probe(['merge-slot', 'check', '--json'], 3_000)
          return res.code === 0 ? parseSlotCheck(res.out) : null
        },
      }
    },
  }
}

/** The beads-backed TaskStore. `dir` selects the store via cwd —
 *  callers that need the global store resolve it themselves
 *  (`resolveGlobalDir` lives in the cli layer). */
export function taskStore(dir?: string): TaskStore {
  return makeStore({
    run: (args) => bd(args, dir),
    json: (args) => bdJson(args, dir),
    probe: (args, ms) => bdTry(args, ms, dir),
    actor: () => bdActor(dir ?? process.cwd()),
    storeDir: join(dir ?? process.cwd(), '.beads'),
  })
}

/** The store pinned by BEADS_DIR, not cwd — the shared-claim plane's
 *  addressing mode: spawned workers and the registry read/claim on the
 *  shared dolt regardless of the caller's checkout. Same contract as
 *  taskStore — only the routing differs. */
export function taskStoreAt(beadsDir: string): TaskStore {
  const fail = (args: string[], r: { code: number; out: string; err: string; ran: boolean }): never => {
    throw Object.assign(new Error(`bd ${args.join(' ')} failed (${r.code}): ${r.err}`), {
      code: r.code,
      stderr: r.err,
      stdout: r.out,
      ran: r.ran,
    })
  }
  return makeStore({
    run: (args) => {
      const r = bdAt(beadsDir, args)
      if (r.code !== 0) {
        fail(args, r)
      }
      return r.out
    },
    json: <T>(args: string[]): T => {
      const r = bdAt(beadsDir, [...args, '--json'])
      if (r.code !== 0) {
        fail(args, r)
      }
      try {
        return JSON.parse(r.out) as T
      } catch (err) {
        throw new Error(
          `bd returned malformed JSON — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    probe: (args, ms) => bdAt(beadsDir, args, ms),
    actor: () => bdActorAt(beadsDir),
    storeDir: beadsDir,
  })
}

/** The read surface of TaskStore in Promise form — the hook-probe
 *  contract. Mutations stay sync: they run on command paths, never in
 *  a connector sweep where parallel probes are the whole point. The
 *  same taskRows/taskRow guards apply — drift fails the same way. */
export interface TaskStoreAsync {
  list(f?: TaskFilter): Promise<TaskRow[]>
  ready(f?: TaskFilter): Promise<TaskRow[]>
  get<T extends TaskRow = TaskRow>(id: string): Promise<T | undefined>
  children<T extends TaskRow = TaskRow>(id: string): Promise<T[]>
  deps<T = TaskDepEdge>(ids: string[], opts?: DepOpts): Promise<T[]>
  neighbors<T extends TaskRow = TaskRow>(id: string, opts?: DepOpts): Promise<T[]>
  actor?(): Promise<string>
  /** Probe-path half of `slot` — the merge slot's session-start read.
   *  Absent when the backend has no slot primitive. */
  slotHolder?(name: string): Promise<string | null>
}

/** Async twin of taskStore — reads only. Every call lands on
 *  bdJsonAsync, so a connector sweep's bd spawns overlap instead of
 *  serializing through the event loop. */
export function taskStoreAsync(dir?: string): TaskStoreAsync {
  return {
    list: async (f = {}) => taskRows(await bdJsonAsync(['list', '--json', ...filterArgs(f)], dir), 'list'),
    ready: async (f = {}) => taskRows(await bdJsonAsync(['ready', ...filterArgs(f)], dir), 'ready'),
    get: async (id) => {
      let r: TaskRow | TaskRow[]
      try {
        r = await bdJsonAsync<TaskRow | TaskRow[]>(['show', id], dir)
      } catch (err) {
        if (isBdNotFound(err)) {
          return undefined as never
        }
        throw err
      }
      return taskRow(Array.isArray(r) ? r[0] : r, 'show') as never
    },
    children: async (id) => taskRows(await bdJsonAsync(['children', id], dir), 'children'),
    deps: async (ids, opts = {}) =>
      foldDepRows(await bdJsonAsync(depArgs(ids, opts), dir), ids, opts),
    neighbors: async (id, opts = {}) =>
      neighborRows(await bdJsonAsync(depArgs([id], opts), dir)),
    actor: () => bdActorAsync(dir ?? process.cwd()),
    slotHolder: async (name) => {
      if (name !== 'merge') {
        return null
      }
      const res = await bdTryAsync(['merge-slot', 'check', '--json'], 3_000, dir)
      return res.code === 0 ? parseSlotCheck(res.out) : null
    },
  }
}
