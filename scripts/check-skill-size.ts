// check-skill-size.ts — a SKILL.md is a prompt-context budget, not a doc:
// past the threshold it crowds out working context. Inferred as the
// per-skill `size-check` target by @nx-devkit/skill:
// tsx scripts/check-skill-size.ts --skill <projectRoot> [--warn-only]

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const MAX_LINES = 250

const { values, positionals } = parseArgs({
  options: {
    skill: { type: 'string' },
    'warn-only': { type: 'boolean' },
  },
  allowPositionals: true,
})

const skillArg = values.skill ?? positionals[0]
if (skillArg === undefined) {
  console.error('usage: tsx scripts/check-skill-size.ts --skill <skill-dir> [--warn-only]')
  process.exit(1)
}

// Confine to the workspace — the arg is agent/CI-supplied.
const skillDir = resolve(skillArg)
const relDir = relative(process.cwd(), skillDir)
if (relDir.startsWith('..') || isAbsolute(relDir)) {
  console.error(`::error::--skill must resolve inside the workspace`)
  process.exit(1)
}
const skillMd = join(skillDir, 'SKILL.md')
if (!existsSync(skillMd)) {
  console.error(`::error file=${skillMd}::SKILL.md not found`)
  process.exit(1)
}

const lines = readFileSync(skillMd, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length
if (lines > MAX_LINES) {
  const level = values['warn-only'] === true ? 'warning' : 'error'
  console.error(`::${level} file=${skillMd}::${lines} lines — SKILL.md budget is ${MAX_LINES}`)
  process.exit(values['warn-only'] === true ? 0 : 1)
}
console.log(`ok ${skillMd} (${lines} lines)`)
