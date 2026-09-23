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

/** Short deterministic tag — distinguishes ids that sanitize to the
 *  same slug (`a/b` vs `a-b` would both become `a-b`). djb2 → base36. */
function hash4(s: string): string {
  let h = 5381
  for (const c of s) {
    h = ((h << 5) + h + c.charCodeAt(0)) >>> 0
  }
  return h.toString(36).slice(0, 4)
}

export function planItem(bead: LoopBead, repoRoot: string): LoopItem {
  let slug = bead.id.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
  if (slug !== bead.id) {
    slug += `-${hash4(bead.id)}`
  }
  const dir = join(dirname(repoRoot), `${basename(repoRoot)}--${slug}`)
  return {
    branch: `loop/${slug}`,
    worktreeDir: dir,
    promptFile: join(dir, '.bro-loop-prompt.md'),
  }
}
