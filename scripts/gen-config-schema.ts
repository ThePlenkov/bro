/**
 * bro.config JSON Schema generator — emits the draft-07 document the
 * config section registry declares (spec: specs/bro-d9dmx.md) into
 * packages/cli/schemas/, shipped inside the @broject/bro tarball so
 * `$schema` pins resolve through unpkg.
 *
 *   node scripts/gen-config-schema.ts          # write
 *   node scripts/gen-config-schema.ts --check  # drift gate
 *
 * Requires `npm run build` first — the registry is read from the built
 * `dist/config-schema.js` entry, never re-declared here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'packages/cli/schemas/bro.config.schema.json')
const entry = join(root, 'packages/cli/dist/config-schema.js')
const check = process.argv.includes('--check')

if (!existsSync(entry)) {
  console.error('packages/cli/dist/config-schema.js missing — run `npm run build` first')
  process.exit(2)
}

// `entry` is this repo's own built dist file (existsSync-gated
// above) — the dynamic import is the generator's whole job:
// nosemgrep
const { emitConfigSchemaJson } = (await import(pathToFileURL(entry).href)) as {
  emitConfigSchemaJson: () => string
}
const content = emitConfigSchemaJson()

if (check) {
  if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== content) {
    console.error('stale: packages/cli/schemas/bro.config.schema.json — run `npm run gen:config-schema`')
    process.exit(1)
  }
} else {
  mkdirSync(dirname(outFile), { recursive: true })
  if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== content) {
    writeFileSync(outFile, content)
  }
  console.log('packages/cli/schemas/bro.config.schema.json')
}
