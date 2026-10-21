/** The ready-set read the engine's verdicts stand on — moved from
 *  `commands/next.ts` (bro-jamp7): `bro next`'s picking logic stays in
 *  the cli; the store resolution + `bd ready` contract are engine
 *  plumbing shared by `rigNext`'s dep-gate and the policies' pick
 *  lists. */
import {
  facade,
  gitTry,
  loadConfig,
  type FacadeOpts,
  type TaskStore,
} from '@broject/core'

export interface ReadyBead {
  id: string
  title: string
  description?: string
  status: string
  priority: number
  issue_type: string
  created_at: string
  parent?: string
  /** bd labels — present on `bd ready --json` rows; the labels scope
   *  filter in plans/argv only claims beads carrying a declared label. */
  labels?: string[]
}

/** Labels that mark coordination primitives, not work — excluded bd-side
 *  so a shared queue's semaphores can never look claimable. Gas Town's
 *  merge-slot bead (<prefix>-merge-slot) is the known instance. */
export const NEVER_CLAIM_LABELS = ['gt:slot']

/** The serving tasks backend for `dir` — `connectors.tasks` in
 *  bro.config selects it (beads by default, github when pinned). The
 *  config lookup anchors at the git root so a run from a subdirectory
 *  resolves the same backend; the global store is beads-only by
 *  construction — its dir carries no bro.config, so resolution falls
 *  to the registry default anyway. `connectors` is a core config
 *  section, so `loadConfig` alone answers it — no plugin registry is
 *  needed (or wanted) on this side of the package boundary. */
export function storeFor(dir?: string, opts?: FacadeOpts): TaskStore {
  const root =
    dir ?? (gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd())
  return facade('tasks', { dir: root }, opts ?? { prefer: loadConfig(root).connectors })
}

/** The single `bd ready` contract for next and loop: coordination
 *  primitives are filtered out by bd itself, before classification.
 *  `dir` retargets the query at another store — `bro next --global`.
 *  `opts.store` pins the store outright: a caller that already resolved
 *  one (loop/drive contexts) gets verdicts consistent with the rows it
 *  reads, and no second resolution runs behind its back. */
export function readyBeads(
  dir?: string,
  opts?: FacadeOpts & { store?: TaskStore }
): ReadyBead[] {
  return (opts?.store ?? storeFor(dir, opts)).ready<ReadyBead>({
    excludeLabels: NEVER_CLAIM_LABELS,
  })
}
