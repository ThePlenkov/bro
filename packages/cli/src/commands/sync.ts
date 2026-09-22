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
  gitTry,
} from '@bro/core'
import { loadBroConfig } from '../plugins.ts'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Beads state (drill frames, wtfs, retros, the ready queue) is not a bro
 *  artifact — it lives in the local Dolt DB with its own transport.
 *  `bd sync` is beads' own pull+merge+push cycle; bro orchestrates it so
 *  one command moves everything an agent needs on another machine.
 *  Best-effort like the data-ref push: no bd, no .beads, or a sync
 *  failure warns but never breaks artifact sync. */
function syncBeads(root: string): void {
  if (!existsSync(join(root, '.beads'))) {
    return
  }
  try {
    // own exec: bd() caps at 15s — a network pull/push needs more room
    execFileSync('bd', ['sync'], { stdio: 'inherit', timeout: 120_000 }) // NOSONAR — PATH lookup is the contract (same as the bd wrapper)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return // bd not installed — beads state simply doesn't move
    }
    console.error(
      `warning: bd sync failed — ${(err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err))}`
    )
  }
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

export function runSyncCommand(argv: string[]): void {
  const pull = argv.includes('--pull')
  const root = dataRefRoot()
  if (root === null) {
    console.error('bro sync: not inside a git worktree')
    process.exit(1)
  }
  const { ref, remote, beads } = loadBroConfig(root).sync

  if (pull) {
    const written = dataRefPull(root, remote, ref)
    if (written < 0) {
      console.error(`bro sync: remote ${remote} has no ${ref}`)
      process.exit(1)
    }
    console.log(`bro sync: materialized ${written} file(s) from ${ref}`)
    if (beads) {
      syncBeads(root)
    }
    return
  }

  const dirs = artifactDirs(root)
  if (dirs.length === 0) {
    console.log('bro sync: no artifact dirs (.agents/, debt dir)')
  } else {
    for (const dir of dirs) {
      const head = dataRefCommit(root, dir, `bro data: sync ${dir}`, ref)
      if (head === null) {
        console.log(`bro sync: ${dir} — nothing to sync`)
      } else {
        console.log(`bro sync: ${dir} → ${ref} @ ${head.slice(0, 8)}`)
      }
    }
    const hasRef = gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', ref]).code === 0
    if (hasRef && !dataRefPush(root, remote, ref)) {
      console.error(
        `warning: could not push ${ref} to ${remote} — check network and remote access`
      )
    } else if (hasRef) {
      console.log(`bro sync: ${ref} pushed to ${remote}`)
    }
  }
  // beads has its own transport — independent of artifact outcome
  if (beads) {
    syncBeads(root)
  }
}
