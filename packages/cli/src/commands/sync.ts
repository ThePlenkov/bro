/**
 * `bro sync [--pull]` — artifact sync on the standalone data ref
 * (refs/bro/data, outside refs/heads). Push (default) commits the
 * untracked+ignored files under `.agents/` and the debt dir to the ref
 * and pushes it; `--pull` fetches the ref and materializes its files
 * into the worktree — the fresh-clone restore path.
 *
 * Tracked content never syncs by construction (`ls-files -o -i
 * --exclude-standard`), so the ref only ever carries artifacts that are
 * deliberately kept out of MR diffs. Sync failures warn but never break
 * the command — offline must not block local work.
 */
import {
  dataRefCommit,
  dataRefPull,
  dataRefPush,
  dataRefRoot,
  facade,
  facadeName,
  gitTry,
  taskStore,
  type TaskStore,
} from '@broject/core'
import { loadBroConfig } from '../plugins.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Task-state replication is a connector capability — `store.sync()`
 *  runs whatever cycle that backend owns (beads: the dolt-refs
 *  pull+merge+push; remote backends usually sync on write and omit the
 *  verb). The serving tasks store syncs; so does the local `.beads`
 *  doc db whenever it isn't that same store — kv/mol state lives there
 *  regardless of which connector answers `tasks`, and its replication
 *  doesn't depend on the serving backend being constructible at all.
 *  Returns the failure count — artifact sync stays best-effort (a warn
 *  never breaks it), but an explicit --pull reports store failure. */
function syncStores(root: string, prefer: Record<string, string>): number {
  let failed = 0
  const stores: TaskStore[] = []
  let serving: string | undefined
  try {
    serving = facadeName('tasks', { dir: root }, { prefer })
    stores.push(facade('tasks', { dir: root }, { prefer }))
  } catch (err) {
    failed++
    console.error(
      `warning: task store sync skipped — ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // the local beads db is a store too — skipped only when it IS the
  // serving store already queued; a remote backend's construction
  // failure must not strand it
  if (serving !== 'beads' || stores.length === 0) {
    stores.push(taskStore(root))
  }
  for (const store of stores) {
    if (store.sync === undefined) {
      continue // the backend syncs on write — nothing to replicate
    }
    try {
      const out = store.sync()
      if (out.trim() !== '') {
        console.log(out.trimEnd())
      }
    } catch (err) {
      failed++
      console.error(
        `warning: task store sync failed — ${(err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err))}`
      )
    }
  }
  return failed
}

function artifactDirs(root: string): string[] {
  const dirs = new Set<string>()
  if (existsSync(join(root, '.agents'))) {
    dirs.add('.agents')
  }
  // mirror the store's own resolution — BRO_DEBT_DIR wins over config
  const debt = process.env.BRO_DEBT_DIR ?? loadBroConfig(root).debt.dir
  if (existsSync(join(root, debt))) {
    dirs.add(debt)
  }
  return [...dirs]
}

/** `--pull`: materialize the data ref, then replicate stores — a store
 *  failure makes the whole restore exit nonzero (reporting success
 *  would lie about the outcome). Failures throw — the CLI's main catch
 *  prints the message and exits 1, exactly what process.exit did. */
function syncPull(root: string, cfg: ReturnType<typeof loadBroConfig>): void {
  const { ref, remote, beads } = cfg.sync
  const written = dataRefPull(root, remote, ref)
  if (written < 0) {
    throw new Error(`bro sync: remote ${remote} has no ${ref}`)
  }
  console.log(`bro sync: materialized ${written} file(s) from ${ref}`)
  if (beads && syncStores(root, cfg.connectors) > 0) {
    throw new Error('bro sync: task store replication failed — local state may be stale')
  }
}

/** The `bro sync` verb — also called in-process by the loop's exit
 *  audit, so fatal failure paths THROW and never exit: an exit would
 *  kill the calling runner mid-write and discard its still-buffered
 *  audit output (bro-qjbwq). Warn-only failures keep their contract —
 *  a failed data-ref push or store sync is best-effort (offline must
 *  not block local work), not a throw. */
export function runSyncCommand(argv: string[]): void {
  const pull = argv.includes('--pull')
  const root = dataRefRoot()
  if (root === null) {
    throw new Error('bro sync: not inside a git worktree')
  }
  const cfg = loadBroConfig(root)
  const { ref, remote, beads } = cfg.sync

  if (pull) {
    syncPull(root, cfg)
    return
  }

  const dirs = artifactDirs(root)
  if (dirs.length === 0) {
    console.log('bro sync: no artifact dirs (.agents/, debt dir)')
  }
  for (const dir of dirs) {
    const head = dataRefCommit(root, dir, `bro data: sync ${dir}`, ref)
    if (head === null) {
      console.log(`bro sync: ${dir} — nothing to sync`)
    } else {
      console.log(`bro sync: ${dir} → ${ref} @ ${head.slice(0, 8)}`)
    }
  }
  // push whenever a local data ref exists — an earlier sync may have left
  // one even when this checkout has no artifact dirs to commit
  const hasRef = gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', ref]).code === 0
  if (hasRef && !dataRefPush(root, remote, ref)) {
    console.error(
      `warning: could not push ${ref} to ${remote} — check network and remote access`
    )
  } else if (hasRef) {
    console.log(`bro sync: ${ref} pushed to ${remote}`)
  }
  // the store has its own transport — independent of artifact outcome
  if (beads) {
    syncStores(root, cfg.connectors)
  }
}
