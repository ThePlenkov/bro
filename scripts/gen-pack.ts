// packages/pack generator — copies the canonical skills/ + formulas/
// trees into the pack package so the published tarball carries the same
// capability files the embedded skills-data.ts snapshot does. Runs from
// @broject/bro-pack's prepack; safe to re-run.
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
for (const dir of ['skills', 'formulas']) {
  const dst = join(root, 'packages/pack', dir)
  rmSync(dst, { recursive: true, force: true })
  cpSync(join(root, dir), dst, { recursive: true })
}
console.error('pack content: skills/, formulas/ → packages/pack')
