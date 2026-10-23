/**
 * Contract gate — the committed `contract/cli.json` snapshot must equal
 * what `bro contract gen` would write (spec bro-k9ces).
 *
 *   node scripts/check-contract.ts           # drift + breaking gate
 *   node scripts/check-contract.ts --write   # regenerate cli.json
 *
 * All diff/announce logic lives in the CLI (`bro contract check|gen`) —
 * this wrapper only supplies the repo's file paths. Requires
 * `npm run build` first: the live dump is read from dist.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const distCli = join(root, 'packages/cli/dist/index.js')

if (!existsSync(distCli)) {
  console.error('packages/cli/dist/index.js missing — run `npm run build` first')
  process.exit(2)
}

const write = process.argv.includes('--write')
const passthrough = process.argv.slice(2).filter((a) => a !== '--write')

// scalar flags are single-occurrence in the CLI — supply the repo
// defaults only when the caller did not override them in passthrough
const given = (name: string): boolean =>
  passthrough.some((a) => a === name || a.startsWith(`${name}=`))
const defaults = [
  ...(given('--contract') ? [] : ['--contract', join(root, 'contract', 'cli.json')]),
  ...(given('--breaking') ? [] : ['--breaking', join(root, 'contract', 'BREAKING.md')]),
]

try {
  execFileSync(
    process.execPath,
    [distCli, 'contract', write ? 'gen' : 'check', ...defaults, ...passthrough],
    { stdio: 'inherit' }
  )
} catch (err) {
  process.exit(
    (err as { status?: number }).status ?? 1
  )
}
