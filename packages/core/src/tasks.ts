/**
 * TaskStore — the typed issue-level surface every bro package consumes.
 * Workflow code never calls bd()/bdJson() for issue ops; it asks for
 * `taskStore(dir)` and gets a narrow contract. Swapping the backend
 * means reimplementing this interface, not every command.
 *
 * Scope is a construction concern: `dir` is the store's working dir —
 * the repo root for project beads, the resolved global dir for
 * user-level ones. The beads CLI routes by cwd; the TaskStore doesn't
 * care which store it fronts.
 *
 * Deliberately absent — beads subsystems that aren't tasks:
 * mol/wisp (molecules), provenance (evidence), merge-slot, config,
 * init/info. Those keep calling bd() until they get doc types.
 */
import { bd, bdJson, bdTry } from './bd.ts'
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

function probeActor(dir: string): string {
  // 'actor = name' — take the value side; 'actor (not set…)' falls through
  const cfg = bdTry(['config', 'get', 'actor'], 3_000, dir)
  const line = cfg.code === 0 ? (cfg.out.trim().split('\n').pop()?.trim() ?? '') : ''
  if (line !== '' && !/not set/i.test(line)) {
    const eq = line.indexOf('=')
    const v = (eq >= 0 ? line.slice(eq + 1) : line).trim().replace(/^['"]|['"]$/g, '')
    if (v !== '') {
      return v
    }
  }
  const git = gitTry(['-C', dir, 'config', 'user.name'])
  if (git.code === 0 && git.out.trim() !== '') {
    return git.out.trim()
  }
  return process.env.USER?.trim() ?? ''
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
  metadata?: Record<string, unknown> | null
}

export interface TaskFilter {
  status?: string
  labels?: string[]
  excludeLabels?: string[]
  /** include closed/done rows */
  all?: boolean
  limit?: number
  type?: string
}

export interface TaskInput {
  title: string
  description?: string
  type?: string
  priority?: number
  labels?: string[]
  /** dep specs the backend understands, e.g. 'discovered-from:<id>' */
  deps?: string[]
  /** parent id — shorthand for a parent-child dep edge */
  parent?: string
  noInheritLabels?: boolean
  externalRef?: string
  /** opaque backend metadata — serialized as JSON */
  metadata?: Record<string, unknown>
  /** backend-level ephemeral/wisp flag — no audit trail */
  ephemeral?: boolean
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
  /** dependency edges touching `ids`, optionally narrowed by type
   *  (e.g. 'parent-child', 'discovered-from') or direction */
  deps<T = unknown>(ids: string[], opts?: { type?: string; direction?: string }): T[]
  link(from: string, to: string, type?: string): void
  /** the store's id prefix — undefined when unset; THROWS when the
   *  probe fails (a shared db must fail closed, not reopen
   *  cross-repo claiming) */
  prefix(): string | undefined
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

function createArgs(i: TaskInput): string[] {
  const args = ['create', '--title', i.title]
  if (i.description) args.push('-d', i.description)
  if (i.type) args.push('-t', i.type)
  if (i.priority !== undefined) args.push('-p', String(i.priority))
  for (const l of i.labels ?? []) args.push('-l', l)
  if (i.deps?.length) args.push('--deps', i.deps.join(','))
  if (i.parent) args.push('--parent', i.parent)
  if (i.ephemeral) args.push('--ephemeral')
  if (i.noInheritLabels) args.push('--no-inherit-labels')
  if (i.externalRef) args.push('--external-ref', i.externalRef)
  if (i.metadata) args.push('--metadata', JSON.stringify(i.metadata))
  return args
}

/** The beads-backed TaskStore. `dir` selects the store via cwd —
 *  callers that need the global store resolve it themselves
 *  (`resolveGlobalDir` lives in the cli layer). */
export function taskStore(dir?: string): TaskStore {
  return {
    list: (f = {}) => bdJson(['list', '--json', ...filterArgs(f)], dir),
    ready: (f = {}) => bdJson(['ready', ...filterArgs(f)], dir),
    get: (id) => {
      const r = bdJson<TaskRow | TaskRow[]>(['show', id], dir)
      // bd show answers an array; empty/undefined = no such task
      return ((Array.isArray(r) ? r[0] : r) ?? undefined) as never
    },
    create: (i) => {
      const r = bdJson<TaskRow | TaskRow[]>(createArgs(i), dir)
      const row = Array.isArray(r) ? r[0] : r
      if (!row) {
        throw new Error('task create returned no row — backend contract broken')
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
      bd(args, dir)
    },
    claim: (id) => {
      bd(['update', id, '--claim'], dir)
    },
    actor: () => bdActor(dir ?? process.cwd()),
    reopen: (id) => {
      bd(['reopen', id], dir)
    },
    close: (id, reason) => {
      bd(['close', id, ...(reason ? ['--reason', reason] : [])], dir)
    },
    remove: (id) => {
      bd(['delete', id, '--force'], dir)
    },
    note: (id, text) => {
      bd(['note', id, text], dir)
    },
    children: (id) => bdJson(['children', id], dir),
    deps: (ids, opts = {}) =>
      bdJson(
        [
          'dep',
          'list',
          ...ids,
          ...(opts.type ? ['-t', opts.type] : []),
          ...(opts.direction ? [`--direction=${opts.direction}`] : []),
        ],
        dir
      ),
    link: (from, to, type = 'related') => {
      bd(['link', from, to, '--type', type], dir)
    },
    prefix: () => {
      const probe = bdTry(['config', 'get', 'issue_prefix'], 15_000, dir)
      if (probe.code !== 0) {
        throw new Error(`task store unreachable — ${probe.err || 'bd error'}`)
      }
      // output may be 'issue_prefix = bro' — take the value side
      const line = probe.out.trim().split('\n').pop()?.trim() ?? ''
      if (line === '' || /not set/i.test(line)) {
        return undefined
      }
      const eq = line.indexOf('=')
      const v = (eq >= 0 ? line.slice(eq + 1) : line).trim().replace(/^['"]|['"]$/g, '')
      return v === '' ? undefined : v
    },
  }
}
