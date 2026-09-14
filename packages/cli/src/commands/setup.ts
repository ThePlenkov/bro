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
    execFileSync(name, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function ghAuthed(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function writeConfig(opts: { beads: boolean; personality?: string }): string[] {
  const path = join(process.cwd(), 'bro.config.json')
  const existed = existsSync(path)
  const existing = existed
    ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<BroConfig>)
    : {}
  const done: string[] = []
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
  if (!existed || JSON.stringify(existing) !== JSON.stringify(merged)) {
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    done.push(`${existed ? 'updated' : 'wrote'} bro.config.json (store: ${merged.store})`)
  } else {
    done.push('bro.config.json already up to date')
  }
  return done
}

function writeSkills(): string[] {
  const done: string[] = []
  for (const [rel, content] of Object.entries(SKILL_FILES)) {
    const path = join(process.cwd(), '.agents', 'skills', rel)
    if (existsSync(path) && readFileSync(path, 'utf8') === content) {
      continue
    }
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
    done.push(`installed .agents/skills/${rel}`)
  }
  return done
}

export async function runSetupCommand(argv: string[]): Promise<void> {
  const beads = argv.includes('--beads')
  const skills = argv.includes('--skills')
  const pIdx = argv.indexOf('--personality')
  const personality = pIdx >= 0 ? argv[pIdx + 1] : undefined

  const gh = hasBin('gh')
  const ghOk = gh && ghAuthed()
  const bd = hasBin('bd')
  console.error(`bro setup: gh ${gh ? (ghOk ? '✓ authed' : '✗ not authed') : '✗ missing'} | bd ${bd ? '✓' : '✗ missing'}`)

  if (!gh) {
    console.error('error: gh CLI is required — https://cli.github.com')
    process.exit(1)
  }
  if (!ghOk) {
    console.error('error: gh not authenticated — run `gh auth login` first')
    process.exit(1)
  }

  for (const msg of writeConfig({ beads, personality })) {
    console.error(`  ${msg}`)
  }

  if (beads) {
    if (!bd) {
      console.error('error: --beads requested but bd not found — https://github.com/gastownhall/beads')
      process.exit(1)
    }
    if (!existsSync(join(process.cwd(), '.beads'))) {
      execFileSync('bd', ['init', '--stealth', '--skip-agents', '--skip-hooks', '--quiet'], {
        stdio: 'inherit',
      })
      console.error('  initialized .beads (stealth — nothing lands in git)')
    } else {
      console.error('  .beads already initialized')
    }
    for (const [name, content] of Object.entries(FORMULA_FILES)) {
      const dest = join(process.cwd(), '.beads', 'formulas', name)
      if (!existsSync(dest) || readFileSync(dest, 'utf8') !== content) {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, content, 'utf8')
        console.error(`  installed .beads/formulas/${name} → bd mol pour debt-pipeline`)
      }
    }
  }

  if (skills) {
    const written = writeSkills()
    for (const msg of written) {
      console.error(`  ${msg}`)
    }
    if (written.length === 0) {
      console.error('  skills already installed and current')
    }
  }

  console.error('bro setup: done. Next: `bro debt prs` to see the queue, `bro debt collect` to sweep.')
}
