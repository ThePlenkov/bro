/**
 * Durable drill reports — `bro drill up --report` materializes the frame's
 * RESULT + PREVENTION memo into a readable md artifact under
 * `drill.report.dir` (default `drills/`). Beads stay the coordination
 * substrate; the file is the *output* — it rides the branch like any
 * source file and `drill up` never commits it.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DrillRow } from './types.ts'

export interface DrillReportInput {
  /** The frame being closed — id, title, description (scope), ephemeral. */
  frame: DrillRow
  /** Descent path [root, …, frame]. */
  chain: string[]
  /** Sub-frames drilled under this frame. */
  children: DrillRow[]
  result: string
  /** Normalized `--prevent` items. */
  prevention: string[]
  /** Per-item bead ids, aligned with `prevention`. */
  preventionIds: string[]
  /** `--evidence` refs. */
  evidence: string[]
  /** Defaults to now — injectable for tests. */
  date?: string
}

export interface DrillReportEntry {
  id: string
  title: string
  /** Absolute path to the report file. */
  path: string
}

/** Frontmatter scalar — JSON.stringify output is a YAML 1.2 double-quoted
 *  scalar, so colons/newlines/markers in result or prevention text can't
 *  break the document. */
const yamlStr = (s: string): string => JSON.stringify(s)

export function renderReport(input: DrillReportInput): string {
  const date = input.date ?? new Date().toISOString()
  const fm = [
    '---',
    `drill: ${yamlStr(input.frame.id)}`,
    `scope: ${yamlStr(input.frame.description ?? input.frame.title)}`,
    `parent-chain: [${input.chain.map(yamlStr).join(', ')}]`,
    `date: ${yamlStr(date)}`,
    `result: ${yamlStr(input.result)}`,
    `prevention: [${input.prevention.map(yamlStr).join(', ')}]`,
    '---',
  ]
  const prevention =
    input.prevention.length === 0
      ? ['(none)']
      : input.prevention.map((p, i) => {
          const id = input.preventionIds[i] ?? ''
          return `- ${p}${id ? ` (${id})` : ''}`
        })
  const children =
    input.children.length === 0
      ? ['  (none)']
      : input.children.map((c) => `  - \`${c.id}\` — ${c.title}`)
  const evidence =
    input.evidence.length === 0 ? ['  (none)'] : input.evidence.map((e) => `  - ${e}`)
  return [
    ...fm,
    '',
    `# drill report — ${input.frame.title}`,
    '',
    '## Result',
    '',
    input.result,
    '',
    '## Prevention',
    '',
    ...prevention,
    '',
    '## Trail',
    '',
    '- children:',
    ...children,
    '- evidence:',
    ...evidence,
    '',
  ].join('\n')
}

/** Writes `<dir>/<frame-id>.md`, creating the dir — returns the path. A
 *  re-report overwrites: the file mirrors the memo, not history. The
 *  write lands via a sibling tmp + rename — an interrupted write must
 *  not leave a truncated "durable" report. */
export function writeReport(dir: string, input: DrillReportInput): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${input.frame.id}.md`)
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, renderReport(input))
  renameSync(tmp, path)
  return path
}

const FM_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/
const FM_DRILL = /^drill:\s*"?([^"\n]+)"?\s*$/m
const TITLE = /^# drill report — (.+)$/m

/** Reports under `dir` — files without a `drill:` frontmatter key aren't
 *  reports and are skipped; an unreadable file fails loudly. The key
 *  must sit inside the delimited frontmatter — a `drill:` line in the
 *  body doesn't make a file a report. */
export function listReports(dir: string): DrillReportEntry[] {
  if (!existsSync(dir)) {
    return []
  }
  const out: DrillReportEntry[] = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const path = join(dir, name)
    const text = readFileSync(path, 'utf8')
    const block = FM_BLOCK.exec(text)
    const fm = block ? FM_DRILL.exec(block[1]!) : null
    if (!fm) {
      continue
    }
    const id = fm[1]!.trim()
    out.push({ id, title: TITLE.exec(text)?.[1]?.trim() ?? id, path })
  }
  return out
}
