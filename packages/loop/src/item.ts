import { basename, dirname, join } from 'node:path'
import type { LoopBead } from './types.ts'

/** Per-item plan — pure naming, no side effects. The worktree is a
 *  sibling `<repo>--<id>` dir on branch `loop/<id>`; the prompt file
 *  lives inside it. */
export interface LoopItem {
  branch: string
  worktreeDir: string
  promptFile: string
}

export function planItem(bead: LoopBead, repoRoot: string): LoopItem {
  const slug = bead.id.replaceAll('/', '-')
  const dir = join(dirname(repoRoot), `${basename(repoRoot)}--${slug}`)
  return {
    branch: `loop/${slug}`,
    worktreeDir: dir,
    promptFile: join(dir, '.bro-loop-prompt.md'),
  }
}
