import { tmpdir } from 'node:os'
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
    h = ((h << 5) + h + (c.codePointAt(0) ?? 0)) >>> 0
  }
  return h.toString(36).slice(0, 4)
}

/** Bead id → worktree/branch slug — sanitized, hash-disambiguated when
 *  the id carries characters the ref namespace can't hold. Exported so
 *  stack member lookups (`stack push` re-enter, loop retries) match the
 *  exact slug a planned item would use. */
export function loopSlug(id: string): string {
  const slug = id.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
  return slug === id ? slug : `${slug}-${hash4(id)}`
}

export function planItem(
  bead: LoopBead,
  repoRoot: string,
  opts?: { stack?: { name: string; n: number } }
): LoopItem {
  const slug = loopSlug(bead.id)
  const dir = join(dirname(repoRoot), `${basename(repoRoot)}--${slug}`)
  return {
    // stack mode joins the named chain — stack/<name>/<n>-<slug> based
    // on the tip; the worktree naming stays identical either way
    branch: opts?.stack ? `stack/${opts.stack.name}/${opts.stack.n}-${slug}` : `loop/${slug}`,
    worktreeDir: dir,
    // outside the worktree — an agent's `git add -A` must never
    // sweep the work order into the PR
    promptFile: join(tmpdir(), 'bro-loop', slug, 'prompt.md'),
  }
}
