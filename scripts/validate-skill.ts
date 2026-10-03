// validate-skill.ts — validate a single skill's SKILL.md frontmatter and
// agents/openai.yaml metadata. Inferred as the per-skill `validate` target
// by @nx-devkit/skill: tsx scripts/validate-skill.ts --skill <projectRoot>.
//
// No external deps on purpose — bro's skills carry minimal frontmatter
// (name + description), so a schema pull (yaml + ajv + a schema file)
// buys nothing the field checks below don't already pin.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: { skill: { type: 'string' } },
  allowPositionals: true,
})

const skillArg = values.skill ?? positionals[0]
if (skillArg === undefined) {
  console.error('usage: tsx scripts/validate-skill.ts --skill <skill-dir>')
  process.exit(1)
}

const skillDir = resolve(skillArg)
const skillMdPath = join(skillDir, 'SKILL.md')
const openaiYamlPath = join(skillDir, 'agents', 'openai.yaml')

let failed = false

if (!existsSync(skillMdPath)) {
  console.error(`::error file=${skillMdPath}::SKILL.md not found`)
  process.exit(1)
}

const skillMd = readFileSync(skillMdPath, 'utf8')
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
if (frontmatter === null) {
  console.error(`::error file=${skillMdPath}::no YAML frontmatter`)
  failed = true
} else {
  const fmLines = frontmatter[1]!.split('\n')
  for (const field of ['name', 'description'] as const) {
    const keyRe = new RegExp(`^${field}:\\s*(.*)$`)
    const idx = fmLines.findIndex((l) => keyRe.test(l))
    let value = idx === -1 ? '' : (keyRe.exec(fmLines[idx]!)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    // Block scalar (`description: >`) or next-line value needs a following
    // indented non-empty line — an empty block is still an empty field.
    if (idx !== -1 && (value === '' || /^[|>]/.test(value))) {
      const next = fmLines.slice(idx + 1).find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
      value = next !== undefined && /^\s/.test(next) ? 'block' : ''
    }
    if (value === '') {
      console.error(`::error file=${skillMdPath}::missing or empty '${field}' in frontmatter`)
      failed = true
    }
  }
}

// agents/openai.yaml is optional in bro — only devin plugin packaging
// carries it; claude/codex copies and some skills ship without one.
if (existsSync(openaiYamlPath)) {
  const openaiYaml = readFileSync(openaiYamlPath, 'utf8')
  for (const key of ['display_name', 'short_description', 'default_prompt'] as const) {
    // Anchored at line start (any indent — keys nest under `interface:`)
    // so comments and longer key names can't satisfy the check.
    if (!new RegExp(`^\\s*${key}:\\s*\\S`, 'm').test(openaiYaml)) {
      console.error(`::error file=${openaiYamlPath}::missing or empty '${key}'`)
      failed = true
    }
  }
}

if (failed) {
  process.exit(1)
}
console.log(`ok ${skillMdPath}`)
