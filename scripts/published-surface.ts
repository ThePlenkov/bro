/**
 * Published-surface helpers — resolve what `npm i -g @broject/bro`
 * actually dispatches. Shared by `gen-published.ts` (writes the
 * contract/published.json snapshot) and `check-onboarding.ts` (the
 * docs↔release gate — spec bro-l8c4f.17).
 *
 * Never *executes* documented commands: several published commands
 * (`bro watch`, `bro sync`, `bro doctor`, `bro fleet`) treat `--help`
 * as "run it" and have real side effects. Everything here is
 * dispatch-level parsing of help output — the only invocations are
 * `bro --help`, `bro --version`, and `bro <name> --help` inside a
 * non-git scratch dir at snapshot-generation time.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(fileURLToPath(import.meta.url), '..', '..')
export const PUBLISHED_PATH = join(root, 'contract', 'published.json')

export interface PublishedSurface {
  package: string
  spec: string
  version: string
  /** announced next release — the version boundary unreleased commands land in */
  next: string
  generatedAt: string
  /** command name → recorded subcommand words (flags may slip in — advisory) */
  commands: Record<string, string[]>
  docNouns: string[]
  docVerbs: string[]
}

export const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** `npm view <spec> version` — resolved semver for a dist-tag or range. */
export function publishedVersion(spec: string): string {
  const out = execFileSync(NPM, ['view', spec, 'version'], { encoding: 'utf8' }).trim()
  // a range spec prints one line per match — the last is the highest
  const lines = out.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /(\d+\.\d+\.\d+(?:[-+][\w.-]*)?)/.exec(lines[i]!)
    if (m) {
      return m[1]!
    }
  }
  throw new Error(`npm view ${spec} version: unparseable output`)
}

/** `npm i -g --prefix <tmp> <spec>` — the clean install users run.
 *  Returns the bro bin path and the fixture dir. */
export function installPublished(spec: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-published-'))
  const prefix = join(dir, 'prefix')
  execFileSync(NPM, ['install', '-g', '--prefix', prefix, spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const bin = join(prefix, 'bin', 'bro')
  if (!existsSync(bin)) {
    throw new Error(`${spec}: no bin/bro under ${prefix}`)
  }
  return { bin, dir }
}

/** Run the installed bin, capturing both streams — spawnSync never
 *  throws on a non-zero exit, which is the point: dispatched-but-
 *  failing commands still print their usage. */
export function runBin(bin: string, args: string[], cwd: string, timeoutMs = 30000): string {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs })
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}

export interface TopHelp {
  /** name → summary line */
  commands: Map<string, string>
  docNouns: string[]
  docVerbs: string[]
}

/** `bro --help` → the Commands: rows plus `doc types:`/`shorthand:`
 *  lines. Indentation-based: rows are `  name   summary`, the block
 *  ends at a blank line. */
export function parseTopLevelHelp(out: string): TopHelp {
  const commands = new Map<string, string>()
  const docNouns: string[] = []
  const docVerbs: string[] = []
  let inCmds = false
  for (const line of out.split('\n')) {
    if (/^\s*Commands:\s*$/.test(line)) {
      inCmds = true
      continue
    }
    if (!inCmds) {
      continue
    }
    const dt = /^\s*doc types:\s+([^—]+)/.exec(line)
    if (dt) {
      docNouns.push(...dt[1]!.trim().split(/\s+/))
      continue
    }
    const sh = /^\s*shorthand:\s+([^—]+)/.exec(line)
    if (sh) {
      docVerbs.push(...sh[1]!.trim().split(/\s+/))
      continue
    }
    const row = /^\s{2}([a-z][\w-]*)\s{2,}(\S.*)$/.exec(line)
    if (row) {
      commands.set(row[1]!, row[2]!)
      continue
    }
    if (line.trim() === '') {
      inCmds = false
    }
  }
  return { commands, docNouns, docVerbs }
}

/** `a|b|c` alternation — the signature shape summaries embed
 *  (`status|up|down`). Scoped to the summary line: inside help bodies
 *  the same shape is flag values (`--by author|source|area`), not subs. */
const ALT_SIG = /[a-z][a-z0-9-]*(?:\|[a-z0-9][a-z0-9-]*)+/

/** Usage grammar tokens that are not subcommands. */
const STOPWORDS = new Set(['command', 'commands', 'subcommand', 'args', 'arg'])

/** Subcommand words for one command, from its summary signature and
 *  its own help output. Only four shapes count — all anchored, so
 *  flag-value alternations and `<id|step>` placeholders stay out:
 *  the registry summary's `a|b` signature, `<a|b|c>` or `a | b`
 *  alternations directly in the subcommand slot, `bro <name> <sub>`
 *  words, and `Commands:` block first tokens. Advisory by design —
 *  consumers treat absence as "unverified", not "absent". */
export function subsOf(name: string, helpOut: string, topSummary?: string): string[] {
  const subs = new Set<string>()
  // a token is "confirmed" when an anchored usage source names it —
  // `bro <n> <sub>` or a Commands: row. Unconfirmed words that also
  // appear as `--word` flags (`--json` inside `install|uninstall|--json`
  // alternations) are flag-name leaks, not subs.
  const confirmed = new Set<string>()
  const push = (w: string, sure: boolean) => {
    if (w === '' || STOPWORDS.has(w)) {
      return
    }
    subs.add(w)
    if (sure) {
      confirmed.add(w)
    }
  }
  const addAlt = (alt: string, sure: boolean) => {
    for (const s of alt.split('|')) {
      push(s.trim(), sure)
    }
  }
  const sig = ALT_SIG.exec(topSummary ?? '')
  if (sig) {
    addAlt(sig[0], false)
  }
  const angled = new RegExp(`\\bbro\\s+${name}\\s+<([a-z0-9][a-z0-9|-]*)>`, 'g')
  for (const m of helpOut.matchAll(angled)) {
    addAlt(m[1]!, true)
  }
  const spaced = new RegExp(`\\bbro\\s+${name}\\s+((?:[a-z][\\w-]*\\s*\\|\\s*)+[a-z][\\w-]*)`, 'g')
  for (const m of helpOut.matchAll(spaced)) {
    addAlt(m[1]!, true)
  }
  const word = new RegExp(`\\bbro\\s+${name}\\s+([a-z][a-z0-9-]*)\\b`, 'g')
  for (const m of helpOut.matchAll(word)) {
    push(m[1]!, true)
  }
  // ` | sub` followers on `bro <name>` lines — `status | distill | run`;
  // `(?!-)` keeps flag alternations (`--json|--live`) out. Not an
  // anchored slot on its own — `<id|step>` followers stay unconfirmed.
  const follower = new RegExp(`\\bbro\\s+${name}\\b[^\\n]*`, 'g')
  for (const line of helpOut.matchAll(follower)) {
    const text = line[0]
    for (const m of text.matchAll(/\|\s*(?!-)([a-z][\w-]*)/g)) {
      // `<id|step>` placeholders — the `|` sits inside angle brackets
      const before = text.slice(0, m.index)
      if (before.split('<').length > before.split('>').length) {
        continue
      }
      push(m[1]!, false)
    }
  }
  let inCmds = false
  for (const line of helpOut.split('\n')) {
    if (/^\s*Commands:\s*$/.test(line)) {
      inCmds = true
      continue
    }
    if (!inCmds) {
      continue
    }
    const m = /^\s{2}([a-z][\w-]*)\s/.exec(line)
    if (m) {
      push(m[1]!, true)
      continue
    }
    if (line.trim() === '') {
      inCmds = false
    }
  }
  const flagText = `${topSummary ?? ''}\n${helpOut}`
  for (const w of subs) {
    if (!confirmed.has(w) && new RegExp(`--${w}\\b`).test(flagText)) {
      subs.delete(w)
    }
  }
  return [...subs].sort()
}

export interface DocLine {
  file: string
  line: number
  /** argv after `bro` / `npx [-y] @broject/bro` */
  argv: string[]
  raw: string
}

/** Every copy/paste `bro …` line inside fenced code blocks. `npm i -g`
 *  lines are skipped — the fixture install IS that step; `npx … bro`
 *  normalizes to `bro` argv. */
export function extractDocLines(file: string): DocLine[] {
  const out: DocLine[] = []
  let inFence = false
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return
      }
      if (!inFence) {
        return
      }
      const m = /^\s*(?:npx(?:\s+-y)?\s+@broject\/bro|bro)\s*(.*)$/.exec(line)
      if (!m) {
        return
      }
      const rest = m[1]!.replace(/\s+#.*$/, '').trim()
      out.push({ file, line: i + 1, argv: rest === '' ? [] : rest.split(/\s+/), raw: line.trim() })
    })
  return out
}

export function loadPublishedSurface(): PublishedSurface | undefined {
  if (!existsSync(PUBLISHED_PATH)) {
    return undefined
  }
  return JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8')) as PublishedSurface
}
