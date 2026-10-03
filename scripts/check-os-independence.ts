// check-os-independence.ts — flag POSIX-only shell snippets inside a
// skill's markdown: SKILL.md bodies load as agent context, so commands
// shown there must run on Linux, macOS, and Windows alike. Inferred as
// the per-skill `os-check` target by @nx-devkit/skill:
// tsx scripts/check-os-independence.ts --skill <projectRoot> [--warn-only]
//
// A file can opt out near the top:  <!-- os-independence-exempt: reason -->

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: {
    skill: { type: 'string' },
    'warn-only': { type: 'boolean' },
  },
  allowPositionals: true,
})

const skillArg = values.skill ?? positionals[0]
if (skillArg === undefined) {
  console.error('usage: tsx scripts/check-os-independence.ts --skill <skill-dir> [--warn-only]')
  process.exit(1)
}
const skillDir = resolve(skillArg)

// Patterns that are not portable to Windows without Git Bash / WSL / translation.
const POSIX_PATTERNS = [
  { token: 'mkdir -p', advice: 'use file tools or a cross-platform mkdir wrapper' },
  { token: 'cat >', advice: 'use file tools or a write operation' },
  { token: 'cat <<', advice: 'use file tools or a write operation' },
  { token: 'chmod ', advice: 'permissions are handled differently on Windows' },
  { token: 'ln -s', advice: 'symlinks require elevated privileges on Windows' },
  { token: 'rm -rf', advice: 'use file removal tools or a cross-platform wrapper' },
  { token: 'cp -r', advice: 'use file tools or a cross-platform wrapper' },
  { token: 'xargs', advice: 'use a loop or a Node/Python script' },
  { token: 'find ', advice: 'use Node/Python or built-in tools' },
  { token: 'awk ', advice: 'use Node/Python for parsing' },
  { token: 'sed ', advice: 'use edit/file tools or a Node/Python script' },
  { token: 'grep ', advice: 'use search tools or a Node/Python script' },
  { token: 'tail ', advice: 'capture output and inspect it, or use a script' },
  { token: 'head ', advice: 'capture output and inspect it, or use a script' },
  { token: 'tee ', advice: 'redirect output manually or use a script' },
  { token: 'mktemp', advice: 'use a Node/Python script for a temp path' },
  { token: '2>/dev/null', advice: 'avoid POSIX-only stderr redirect in cross-platform examples' },
  { token: '2>&1', advice: 'avoid POSIX-only stderr redirect in cross-platform examples' },
  { token: '/dev/null', advice: 'avoid Unix-only sink' },
  { token: '/usr/bin/', advice: 'avoid hardcoded Unix paths' },
  { token: '/bin/', advice: 'avoid hardcoded Unix paths' },
]

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* walk(path)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield path
    }
  }
}

// Deliberate escape hatch near the top of the file — for recipes that are
// bash-by-design (the marker must carry a reason).
function hasOsIndependenceExemption(text: string): boolean {
  const head = text.split('\n').slice(0, 20).join('\n')
  return /^[ \t]*<!--[ \t]*os-independence-exempt:[ \t]*[^>\r\n]+-->[ \t]*$/im.test(head)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Word boundary for command tokens so 'head' does not match 'ahead'.
function tokenMatches(line: string, token: string): boolean {
  return /^\w/.test(token) ? new RegExp(`\\b${escapeRegExp(token)}`).test(line) : line.includes(token)
}

// `git grep` ships with Git on Windows too — not a POSIX-only pattern.
const isGitSubcommand = (line: string, token: string): boolean =>
  token === 'grep ' && line.includes('git grep')

interface Issue {
  file: string
  line: number
  token: string
  advice: string
}

const issues: Issue[] = []
for await (const path of walk(skillDir)) {
  const text = await readFile(path, 'utf8')
  if (hasOsIndependenceExemption(text)) {
    continue
  }
  const rel = relative(process.cwd(), path).replace(/\\/g, '/')
  const lines = text.split('\n')
  let inShell = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^```(bash|sh|shell)\b/.test(line)) {
      inShell = true
      continue
    }
    if (inShell && line.startsWith('```')) {
      inShell = false
      continue
    }
    if (!inShell) {
      continue
    }
    for (const { token, advice } of POSIX_PATTERNS) {
      if (tokenMatches(line, token) && !isGitSubcommand(line, token)) {
        issues.push({ file: rel, line: i + 1, token, advice })
      }
    }
  }
}

if (issues.length === 0) {
  console.log(`ok ${skillDir} — no POSIX-only shell patterns`)
  process.exit(0)
}

for (const i of issues) {
  const level = values['warn-only'] === true ? 'warning' : 'error'
  console.error(`::${level} file=${i.file},line=${i.line}::'${i.token.trim()}' — ${i.advice}`)
}
process.exit(values['warn-only'] === true ? 0 : 1)
