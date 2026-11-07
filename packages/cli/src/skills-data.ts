/**
 * The embedded capability snapshot — NOT generated.
 *
 * Resolution order:
 *   - Source runs (tsx tests, repo development): collected live from the
 *     repo's skills/ + formulas/ trees — the single source of truth. No
 *     generated file is committed, so the data can never go stale here.
 *   - Published bundle: read from `generated/skills-data.json`, an asset
 *     emitted into dist/ at bundle time by the tsdown plugin (see
 *     tsdown.config.ts). `npm run check:embedded` verifies it in CI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEmbedded, type EmbeddedData } from './embedded.ts'

// src/skills-data.ts sits three levels under the repo root; so does every
// dist/*.js bundle chunk — ../../.. lands on the repo root in development
// and on node_modules in an install (no package.json → the artifact path
// below). The live path is admitted only for this repo: the root package
// name matches AND packages/cli/package.json is @broject/bro (existsSync
// alone would let a same-named consumer monorepo's own cli package pass)
// AND repo markers exist — skills/ + formulas/ — so a consumer project
// literally named "bro" with its own skills trees still falls through to
// the shipped snapshot.
function repoRoot(): string | null {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  try {
    const isRepo =
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'bro' &&
      JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).name === '@broject/bro' &&
      existsSync(join(root, 'skills')) &&
      existsSync(join(root, 'formulas'))
    return isRepo ? root : null
  } catch {
    return null
  }
}

const root = repoRoot()
let data: EmbeddedData
if (root !== null) {
  data = collectEmbedded(root)
} else {
  const artifact = new URL('./generated/skills-data.json', import.meta.url)
  if (!existsSync(artifact)) {
    throw new Error('embedded skills data missing — broken @broject/bro install (expected generated/skills-data.json next to the bundle)')
  }
  data = JSON.parse(readFileSync(artifact, 'utf8')) as EmbeddedData
}

export const { SKILL_FILES, FORMULA_FILES } = data
