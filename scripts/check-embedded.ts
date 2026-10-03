/**
 * Verify the embedded snapshot the tarball ships is current:
 * compares packages/cli/dist/generated/skills-data.json (emitted by the
 * tsdown plugin at bundle time) against a live collect of the repo's
 * skills/* + formulas/* trees. Run after `npm run build` — the artifact is
 * a build output now, no generated file is committed anymore.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEmbedded } from '../packages/cli/src/embedded.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const artifact = join(root, 'packages/cli/dist/generated/skills-data.json')

if (!existsSync(artifact)) {
  console.error('dist/generated/skills-data.json not found — run npm run build first')
  process.exit(1)
}

const current = collectEmbedded(root)
const embedded: unknown = JSON.parse(readFileSync(artifact, 'utf8'))
if (JSON.stringify(embedded) !== JSON.stringify(current)) {
  console.error('dist/generated/skills-data.json is stale — rebuild (npm run build)')
  process.exit(1)
}
console.error(
  `embedded snapshot is current: ${Object.keys(current.SKILL_FILES).length} skill file(s), ${Object.keys(current.FORMULA_FILES).length} formula(s)`
)
