import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** npm name of the default pack — `bro setup --pack` resolves this
 *  unless `--pack <name>` or `pack` in bro.config overrides. */
export const PACK_NAME = '@broject/bro-pack'

/** Absolute dir holding this pack's `skills/` + `formulas/` trees —
 *  dist/ and src/ sit at the same depth under the package root, so one
 *  hop up works from both built and source runs. */
export function packDir(): string {
  return dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
}
