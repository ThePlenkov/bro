/** Real-git fixture shared by command tests: a throwaway repo with one
 *  `main` checkout, plus the chdir-and-clean wrapper. Test files must
 *  not re-declare these — SonarCloud counts fixture clones as
 *  duplication on new code. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** mkdtemp repo → `main` checkout with git identity and one commit.
 *  `seed` may drop files before the commit; without it the commit is
 *  --allow-empty. */
export function initRepo(prefix: string, seed?: (main: string) => void): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const main = join(root, 'main')
  git(['init', '-q', '-b', 'main', main], root)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  seed?.(main)
  git(['add', '-A'], main)
  git(['commit', '-qm', 'init', '--allow-empty'], main)
  return { root, main }
}

/** Run fn in dir, then always restore cwd and delete the repo. */
export function inside<T>(dir: string, root: string, fn: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(prev)
    rmSync(root, { recursive: true, force: true })
  }
}
