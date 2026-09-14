/**
 * `bro setup` — wire bro into the current repo.
 *
 *   bro setup [--beads] [--skills] [--personality NAME]
 *
 * Detects gh + bd, writes bro.config.json (never clobbers existing keys),
 * optionally runs `bd init --stealth`, and drops thin skill wrappers into
 * .agents/skills/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CONFIG, type BroConfig } from '@bro/core'
import { FORMULA_FILES, SKILL_FILES } from '../skills-data.ts'

function hasBin(name: string): boolean {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' }) // NOSONAR — user-installed CLI; PATH lookup is the contract
    return true
  } catch {
    return false
  }
}

function ghAuthed(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }) // NOSONAR — PATH lookup is the contract
    return true
  } catch {
    return false
  }
}

function readExistingConfig(path: string): Partial<BroConfig> | null {
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<BroConfig>
  } catch (err) {
    console.error(`error: bro.config.json is not valid JSON — ${(err as Error).message}`)
    process.exit(1)
  }
}

function writeConfig(opts: { beads: boolean; personality?: string }): string {
  const path = join(process.cwd(), 'bro.config.json')
  const existed = existsSync(path)
  const existing = readExistingConfig(path)!
  const merged: BroConfig = {
    ...DEFAULT_CONFIG,
    ...existing,
    debt: { ...DEFAULT_CONFIG.debt, ...existing.debt },
  }
  if (opts.beads) {
    merged.store = 'both'
  }
  if (opts.personality) {
    merged.personality = opts.personality as BroConfig['personality']
  }
  if (existed && JSON.stringify(existing) === JSON.stringify(merged)) {
    return 'bro.config.json already up to date'
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return `${existed ? 'updated' : 'wrote'} bro.config.json (store: ${merged.store})`
}

/** Install files under root; returns installed count. Warns on drift. */
function installFiles(root: string, files: Record<string, string>, what: string): number {
  let n = 0
  for (const [rel, content] of Object.entries(files)) {
    const path = join(process.cwd(), root, rel)
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') === content) {
        continue
      }
      console.error(`  warning: overwriting modified ${what} ${rel}`)
    }
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
    n += 1
    console.error(`  installed ${root}/${rel}`)
  }
  return n
}

function setupBeads(): void {
  if (!existsSync(join(process.cwd(), '.beads'))) {
    execFileSync('bd', ['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'], { // NOSONAR — user-installed CLI; PATH lookup is the contract
      stdio: 'inherit',
    })
    console.error('  initialized .beads (stealth — nothing lands in git)')
  } else {
    console.error('  .beads already initialized')
  }
  installFiles(join('.beads', 'formulas'), FORMULA_FILES, 'formula')
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  const beads = argv.includes('--beads')
  const skills = argv.includes('--skills')
  const pIdx = argv.indexOf('--personality')
  const personality = pIdx >= 0 ? argv[pIdx + 1] : undefined

  const gh = hasBin('gh')
  const ghOk = gh && ghAuthed()
  const bd = hasBin('bd')
  let ghState = '✗ missing'
  if (gh) {
    ghState = ghOk ? '✓ authed' : '✗ not authed'
  }
  console.error(`bro setup: gh ${ghState} | bd ${bd ? '✓' : '✗ missing'}`)

  if (!gh) {
    console.error('error: gh CLI is required — https://cli.github.com')
    process.exit(1)
  }
  if (!ghOk) {
    console.error('error: gh not authenticated — run `gh auth login` first')
    process.exit(1)
  }
  // Validate prerequisites before writing anything — a config pointing at a
  // store we can't run would strand the repo.
  if (beads && !bd) {
    console.error('error: --beads requested but bd not found — https://github.com/gastownhall/beads')
    process.exit(1)
  }

  console.error(`  ${writeConfig({ beads, personality })}`)

  if (beads) {
    setupBeads()
  }

  if (skills) {
    if (installFiles(join('.agents', 'skills'), SKILL_FILES, 'skill') === 0) {
      console.error('  skills already installed and current')
    }
  }

  console.error('bro setup: done. Next: `bro debt prs` to see the queue, `bro debt collect` to sweep.')
}
