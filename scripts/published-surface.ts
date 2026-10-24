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

/** `-flag value` lookup for the two registry-facing scripts. */
export function argFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/** The npm spec to probe: `--spec`, then `BRO_PUBLISHED_SPEC`, then latest. */
export function resolveSpec(argv: string[]): string {
  return argFlag(argv, '--spec') ?? process.env.BRO_PUBLISHED_SPEC ?? '@broject/bro@latest'
}

/** `pkg@<resolved-version>` — the install must pin what `publishedVersion`
 *  resolved: a floating dist-tag (`latest`) could move between the version
 *  probe and `npm i`, recording one version's help under another. */
export function pinSpec(spec: string, version: string): string {
  const at = spec.lastIndexOf('@')
  const pkg = at > 0 ? spec.slice(0, at) : spec
  return `${pkg}@${version}`
}

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
  // a failed spawn or a timeout kill returns near-empty output that
  // downstream parsers would silently read as "no such surface" — a
  // dead probe must fail loudly. A plain non-zero exit is fine:
  // dispatched-but-failing commands still print usage to stderr.
  if (r.error !== undefined || r.signal !== null) {
    throw new Error(`${bin} ${args.join(' ')}: ${r.error?.message ?? `killed by ${r.signal}`}`)
  }
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}

export interface TopHelp {
  /** name → summary line */
  commands: Map<string, string>
  docNouns: string[]
  docVerbs: string[]
}

/** Resolve the spec, install it version-pinned, and probe `bro --help` —
 *  the shared fixture for `gen-published.ts` and `check-onboarding.ts`.
 *  `scratch` is a non-git dir inside the fixture: several published
 *  commands run on `--help`, and a repo cwd would give them a store. */
export function probePublished(spec: string): {
  bin: string
  dir: string
  scratch: string
  top: TopHelp
  version: string
} {
  const version = publishedVersion(spec)
  const { bin, dir } = installPublished(pinSpec(spec, version))
  const scratch = mkdtempSync(join(dir, 'scratch-'))
  const top = parseTopLevelHelp(runBin(bin, ['--help'], scratch))
  return { bin, dir, scratch, top, version }
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

/** Candidate subcommand words: `subs` is every word an extraction
 *  shape saw; `confirmed` is the subset an anchored usage source
 *  (`bro <n> <sub>` slot or a Commands: row) named outright. */
interface Subs {
  subs: Set<string>
  confirmed: Set<string>
}

function pushSub(acc: Subs, w: string, sure: boolean): void {
  if (w === '' || STOPWORDS.has(w)) {
    return
  }
  acc.subs.add(w)
  if (sure) {
    acc.confirmed.add(w)
  }
}

function pushAlt(acc: Subs, alt: string, sure: boolean): void {
  for (const s of alt.split('|')) {
    pushSub(acc, s.trim(), sure)
  }
}

/** `<word>` followed by a non-word char — the boundary a `\b` pattern
 *  asserts, without a dynamic `RegExp` constructor (non-literal patterns
 *  read as user-controlled regex builds to static analysis). */
export function hasFlagWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const after = text[i + word.length]
    if (after === undefined || !/\w/.test(after)) {
      return true
    }
  }
  return false
}

/** Slot shapes anchored right after the command name — literal
 *  patterns, applied to the text following each `bro <name>` hit. */
const ANGLED_SLOT = /^\s+<([a-z0-9][a-z0-9|-]*)>/
const SPACED_SLOT = /^\s+((?:[a-z][\w-]*\s*\|\s*)+[a-z][\w-]*)/
const WORD_SLOT = /^\s+([a-z][a-z0-9-]*)\b/

/** Every `bro <name>` usage occurrence — `bro` plus whitespace plus a
 *  word-bounded name. The command name is dynamic, so the anchor is
 *  indexOf + boundary checks, not `new RegExp(name)`. `line` is the
 *  matched line's remainder; `tail` the remainder of the whole help
 *  text (a slot alternation may wrap to the next line). */
function forEachUsage(
  helpOut: string,
  name: string,
  take: (line: string, tail: string) => void,
): void {
  for (let i = helpOut.indexOf(name); i !== -1; i = helpOut.indexOf(name, i + 1)) {
    if (i === 0 || !/\s/.test(helpOut[i - 1]!)) {
      continue
    }
    let s = i - 1
    while (s > 0 && /\s/.test(helpOut[s - 1]!)) {
      s--
    }
    if (s < 3 || helpOut.slice(s - 3, s) !== 'bro' || /\w/.test(helpOut[s - 4] ?? '')) {
      continue
    }
    const end = i + name.length
    if (/\w/.test(helpOut[end] ?? '')) {
      continue
    }
    const nl = helpOut.indexOf('\n', end)
    take(helpOut.slice(end, nl === -1 ? undefined : nl), helpOut.slice(end))
  }
}

/** Anchored usage slots: `bro <name> <a|b>`, `bro <name> a | b`,
 *  and `bro <name> <word>` — every hit confirms the subcommand. */
function collectUsageSlots(acc: Subs, name: string, helpOut: string): void {
  forEachUsage(helpOut, name, (_line, tail) => {
    const angled = ANGLED_SLOT.exec(tail)
    if (angled) {
      pushAlt(acc, angled[1]!, true)
    }
    const spaced = SPACED_SLOT.exec(tail)
    if (spaced) {
      pushAlt(acc, spaced[1]!, true)
    }
    const word = WORD_SLOT.exec(tail)
    if (word) {
      pushSub(acc, word[1]!, true)
    }
  })
}

/** ` | sub` followers inside one `bro <name>` line — `status |
 *  distill | run`. `(?!-)` keeps flag alternations (`--json|--live`)
 *  out, and the `<`-balance keeps `<id|step>` placeholders out. Not an
 *  anchored slot on its own — followers stay unconfirmed. */
function collectFollowerLine(acc: Subs, text: string): void {
  for (const m of text.matchAll(/\|\s*(?!-)([a-z][\w-]*)/g)) {
    const before = text.slice(0, m.index)
    if (before.split('<').length <= before.split('>').length) {
      pushSub(acc, m[1]!, false)
    }
  }
}

function collectFollowers(acc: Subs, name: string, helpOut: string): void {
  forEachUsage(helpOut, name, (line) => collectFollowerLine(acc, line))
}

/** The `Commands:` block of a command's own help — each row's first
 *  token is a confirmed subcommand. Same indentation walk as
 *  parseTopLevelHelp, at one level down. */
function collectCommandsBlock(acc: Subs, helpOut: string): void {
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
      pushSub(acc, m[1]!, true)
      continue
    }
    if (line.trim() === '') {
      inCmds = false
    }
  }
}

/** Unconfirmed words that also appear as `--word` (`--json` inside
 *  `install|uninstall|--json` alternations) are flag-name leaks, not
 *  subcommands. */
function dropFlagLeaks(acc: Subs, flagText: string): void {
  for (const w of acc.subs) {
    if (!acc.confirmed.has(w) && hasFlagWord(flagText, `--${w}`)) {
      acc.subs.delete(w)
    }
  }
}

/** Subcommand words for one command, from its summary signature and
 *  its own help output. Only four shapes count — all anchored, so
 *  flag-value alternations and `<id|step>` placeholders stay out:
 *  the registry summary's `a|b` signature, `<a|b|c>` or `a | b`
 *  alternations directly in the subcommand slot, `bro <name> <sub>`
 *  words, and `Commands:` block first tokens. Advisory by design —
 *  consumers treat absence as "unverified", not "absent". */
export function subsOf(name: string, helpOut: string, topSummary?: string): string[] {
  const acc: Subs = { subs: new Set(), confirmed: new Set() }
  const sig = ALT_SIG.exec(topSummary ?? '')
  if (sig) {
    pushAlt(acc, sig[0], false)
  }
  collectUsageSlots(acc, name, helpOut)
  collectFollowers(acc, name, helpOut)
  collectCommandsBlock(acc, helpOut)
  dropFlagLeaks(acc, `${topSummary ?? ''}\n${helpOut}`)
  return [...acc.subs].sort((a, b) => a.localeCompare(b))
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
