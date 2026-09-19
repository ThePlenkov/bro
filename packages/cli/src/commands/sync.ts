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
  loadConfig,
} from '@bro/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function artifactDirs(root: string): string[] {
  const dirs = new Set<string>()
  if (existsSync(join(root, '.agents'))) {
    dirs.add('.agents')
  }
  const debt = loadConfig(root).debt.dir
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
  const { ref, remote } = loadConfig(root).sync

  if (pull) {
    const written = dataRefPull(root, remote, ref)
    if (written < 0) {
      console.error(`bro sync: remote ${remote} has no ${ref}`)
      process.exit(1)
    }
    console.log(`bro sync: materialized ${written} file(s) from ${ref}`)
    return
  }

  const dirs = artifactDirs(root)
  if (dirs.length === 0) {
    console.log('bro sync: no artifact dirs (.agents/, debt dir) — nothing to do')
    return
  }
  for (const dir of dirs) {
    const head = dataRefCommit(root, dir, `bro data: sync ${dir}`, ref)
    if (head === null) {
      console.log(`bro sync: ${dir} — nothing to sync`)
    } else {
      console.log(`bro sync: ${dir} → ${ref} @ ${head.slice(0, 8)}`)
    }
  }
  const hasRef = gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', ref]).code === 0
  if (!hasRef) {
    return // nothing committed — nothing to push
  }
  if (!dataRefPush(root, remote, ref)) {
    console.error(
      `warning: could not push ${ref} to ${remote} — check network and remote access`
    )
    return
  }
  console.log(`bro sync: ${ref} pushed to ${remote}`)
}
