/**
 * `bro check` — sverka-backed check facade.
 *
 * sverka is the executor: it loads sverka.config.ts, binds an Entry into
 * a Run Plan (plan-time evaluation can materialize artifacts — e.g.
 * gqlb-built GraphQL queries), runs steps with parallelism, and returns
 * per-step stats + SARIF findings. bro owns what comes back: this command
 * parses `sverka run --format json` and renders it in bro conventions —
 * findings→beads dedup is a follow-up on the debt-source seam.
 *
 *   bro check [--root dir] [--config path] [--entry id]
 *             [--executor host|docker] [--evaluate]
 *             [--format text|json | --json] [-q|--quiet] [-v|--verbose]
 *
 * Binary resolution (first hit): bro.config `check.bin` →
 * `<root>/node_modules/.bin/sverka` walking up → `sverka` on PATH → the
 * `sverka` bundled with @broject/bro. Exit code mirrors the
 * executor; usage errors exit 2.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, existsSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { X_OK } from 'node:constants'
import { flag } from './args.ts'
import { CHECK_EXECUTORS, checkSection, type CheckConfig } from './check-config.ts'
import { loadBroConfig } from '../plugins.ts'

export { checkSection, type CheckConfig } from './check-config.ts'

// --- sverka contract -----------------------------------------------------------

export interface SverkaStep {
  stepId: string
  status: string
  durationMs?: number
  exitCode?: number
  error?: string
  stdout?: string
  stderr?: string
  cacheKey?: string
}

export interface SverkaRunData {
  planId?: string
  status?: string
  steps?: SverkaStep[]
  findings?: number
  verdict?: string
  summary?: unknown
}

export interface CheckReport {
  status: string
  durationMs: number
  steps: SverkaStep[]
  findings?: number
  verdict?: string
  summary?: unknown
  /** sverka's own exit code — bro check propagates it. */
  exitCode: number
}

/** A spawn target — `[file, ...prefixArgs]`: binaries run directly, the
 *  bundled sverka runs as `node dist/bin.mjs`. */
export interface SverkaBin {
  file: string
  args: string[]
  /** for error/verbose reporting — where this resolution came from */
  via?: string
}

/** A runnable regular file — existsSync alone lets a stale or
 *  directory-valued `.bin` entry win resolution. */
function runnableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) {
      return false
    }
    accessSync(p, X_OK)
    return true
  } catch {
    return false
  }
}

const IS_WIN = process.platform === 'win32'
/** npm bin shims are extensionless shell scripts on POSIX and `.cmd`
 *  launchers on Windows; `.exe` covers non-npm installs. */
const PATH_NAMES = IS_WIN ? ['sverka.exe', 'sverka.cmd', 'sverka.bat', 'sverka'] : ['sverka']

/** sverka package entries, current package first. `@sverka/cli` is the
 *  deprecated pre-rename name — kept because a consumer repo may still
 *  pin it, and that install resolves exactly as it did before. */
const PKG_ENTRIES = [
  ['sverka', 'dist', 'bin.mjs'],
  ['@sverka', 'cli', 'dist', 'bin.mjs'],
] as const

/** `<dir>/node_modules` sverka walking up — the repo's own pinned
 *  install wins over PATH and the bundled copy. The package entry
 *  (`sverka/dist/bin.mjs`) is preferred: it spawns through
 *  `process.execPath`, sidestepping shim/shebang/.cmd exec rules. */
function repoLocalBin(root: string): SverkaBin | undefined {
  let dir = resolve(root)
  for (;;) {
    const nm = join(dir, 'node_modules')
    for (const parts of PKG_ENTRIES) {
      const entry = join(nm, ...parts)
      if (existsSync(entry)) {
        return { file: process.execPath, args: [entry], via: 'repo' }
      }
    }
    for (const name of PATH_NAMES) {
      const shim = join(nm, '.bin', name)
      if (runnableFile(shim)) {
        return { file: shim, args: [], via: 'repo' }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

function pathBin(): SverkaBin | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') {
      continue
    }
    for (const name of PATH_NAMES) {
      const p = join(dir, name)
      if (runnableFile(p)) {
        return { file: p, args: [], via: 'PATH' }
      }
    }
  }
  return undefined
}

/** The sverka bundled with @broject/bro — walk up from this module's own
 *  dir looking for `node_modules/sverka/dist/bin.mjs` (workspace layout
 *  and installed-layout both resolve; the package is ESM-only so
 *  require.resolve can't see it, and import.meta.resolve isn't
 *  guaranteed under every loader). The legacy `@sverka/cli` path stays
 *  in the probe list for installs predating the rename. */
function bundledBin(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    for (const parts of PKG_ENTRIES) {
      const bin = join(dir, 'node_modules', ...parts)
      if (existsSync(bin)) {
        return bin
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

/** Resolution order: config bin → repo-local .bin → PATH → bundled.
 *  `check.bin` with a path separator is treated as a path (relative to
 *  root); a bare name is a PATH command. Returns null when nothing
 *  resolves. */
export function resolveSverka(root: string, cfgBin?: string): SverkaBin | null {
  if (cfgBin !== undefined) {
    if (cfgBin.includes('/') || cfgBin.includes(sep)) {
      const p = isAbsolute(cfgBin) ? cfgBin : resolve(root, cfgBin)
      return existsSync(p) ? { file: p, args: [], via: 'config' } : null
    }
    // bare command name — trust PATH like gh/bd resolution does
    return { file: cfgBin, args: [], via: 'config' }
  }
  const local = repoLocalBin(root)
  if (local !== undefined) {
    return local
  }
  const onPath = pathBin()
  if (onPath !== undefined) {
    return onPath
  }
  const bundled = bundledBin()
  if (bundled !== undefined) {
    return { file: process.execPath, args: [bundled], via: 'bundled' }
  }
  return null
}

// --- run ---------------------------------------------------------------------

interface ParsedRun {
  data?: SverkaRunData
  error?: string
  message?: string
  durationMs?: number
}

/** sverka writes one JSON line on stdout under `-f json`; warnings may
 *  precede it, so scan from the end for the envelope. */
function parseRunJson(stdout: string): ParsedRun | null {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as ParsedRun & { command?: string }
      if (parsed.command === 'run') {
        return parsed
      }
    } catch {
      // not the envelope — keep scanning
    }
  }
  return null
}

function sverkaArgs(opts: {
  config?: string
  entry?: string
  executor?: string
  evaluate: boolean
  quiet: boolean
  verbose: boolean
}): string[] {
  const args = ['run', '--format', 'json']
  if (opts.config !== undefined) {
    args.push('--config', opts.config)
  }
  if (opts.entry !== undefined) {
    args.push('--entry', opts.entry)
  }
  if (opts.executor !== undefined) {
    args.push('--executor', opts.executor)
  }
  if (opts.evaluate) {
    args.push('--evaluate')
  }
  if (opts.quiet) {
    args.push('--quiet')
  }
  if (opts.verbose) {
    args.push('--verbose')
  }
  return args
}

/** `.cmd`/`.bat` shims (Windows npm bins, a `check.bin` pointing at one)
 *  can't be spawned directly — route through the command interpreter. */
function spawnTarget(bin: SverkaBin): { file: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(bin.file)) {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', bin.file, ...bin.args],
    }
  }
  return bin
}

function spawnRun(bin: SverkaBin, root: string, args: string[]) {
  const target = spawnTarget(bin)
  return spawnSync(target.file, [...target.args, ...args], {
    cwd: root,
    encoding: 'utf8',
    // step stdout/stderr ride inside the JSON payload — headroom for
    // chatty checks
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  })
}

interface RunOutcome {
  proc: ReturnType<typeof spawnRun>
  parsed: ParsedRun | null
}

/** One spawn + envelope parse — the COLLECTION_FAILED retry lives here:
 *  `--evaluate` against a config whose steps emit no SARIF artifacts
 *  makes sverka drop the whole run report, so bro retries once without
 *  it and the stats still land. */
function executeSverka(
  bin: SverkaBin,
  root: string,
  opts: Parameters<typeof sverkaArgs>[0],
  err: (msg: string) => void
): RunOutcome {
  const first = spawnRun(bin, root, sverkaArgs(opts))
  const parsed = first.stdout ? parseRunJson(first.stdout) : null
  if (parsed?.error !== 'COLLECTION_FAILED') {
    return { proc: first, parsed }
  }
  err(
    `warning: sverka evaluate failed (${parsed.message ?? 'collection failed'}) — retrying without --evaluate; drop it from flags/config or declare SARIF artifact outputs`
  )
  const retry = spawnRun(bin, root, sverkaArgs({ ...opts, evaluate: false }))
  return { proc: retry, parsed: retry.stdout ? parseRunJson(retry.stdout) : null }
}

/** parsed data → the normalized text-render view; absent fields stay
 *  absent rather than defaulting into misleading zeros. */
function toReport(data: SverkaRunData, durationMs: number, code: number): CheckReport {
  return {
    status: data.status ?? 'unknown',
    durationMs,
    steps: data.steps ?? [],
    ...(data.findings !== undefined ? { findings: data.findings } : {}),
    ...(data.verdict !== undefined ? { verdict: data.verdict } : {}),
    ...(data.summary !== undefined ? { summary: data.summary } : {}),
    exitCode: code,
  }
}

/** Execute sverka and normalize to a CheckReport. `data` is sverka's raw
 *  payload — the `--json` output passes it through verbatim (planId and
 *  future fields included); `report` is the normalized text-render view.
 *  Neither is set when the output can't be parsed (details on err). */
export function runCheck(
  bin: SverkaBin,
  root: string,
  opts: Parameters<typeof sverkaArgs>[0],
  err: (msg: string) => void = (m) => console.error(m)
): { report?: CheckReport; data?: SverkaRunData; exitCode: number } {
  const { proc, parsed } = executeSverka(bin, root, opts, err)
  if (proc.error) {
    err(`error: failed to run sverka (${proc.error.message})`)
    return { exitCode: 1 }
  }
  const code = proc.status ?? 1
  if (parsed === null) {
    const tail = (proc.stderr ?? '').trim().split('\n').slice(-5).join('\n')
    err(
      `error: sverka exited ${code} without a JSON run report` +
        (tail !== '' ? `\n${tail}` : '')
    )
    return { exitCode: code === 0 ? 1 : code }
  }
  if (parsed.error !== undefined) {
    err(`error: sverka ${parsed.error}: ${parsed.message ?? 'run failed'}`)
    return { exitCode: code === 0 ? 1 : code }
  }
  const data = parsed.data ?? {}
  return {
    report: toReport(data, parsed.durationMs ?? 0, code),
    data,
    exitCode: code,
  }
}

// --- render --------------------------------------------------------------------

const STEP_ICON: Record<string, string> = {
  succeeded: '✓',
  'cache-hit': '✓',
  failed: '✗',
  skipped: '-',
  cancelled: '-',
  suspended: '-',
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) {
    return ''
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/** Last few non-empty stderr lines — the useful part of a failed step. */
function stderrTail(stderr: string | undefined, n = 4): string[] {
  if (!stderr) {
    return []
  }
  return stderr
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
}

/** One step → its rendered line(s): the status line, plus the indented
 *  stderr tail when it failed. */
function stepLines(s: SverkaStep): string[] {
  const icon = STEP_ICON[s.status] ?? '?'
  const dur = s.durationMs !== undefined ? ` ${fmtMs(s.durationMs)}` : ''
  let detail = ''
  if (s.status === 'failed') {
    detail = s.error ?? (s.exitCode !== undefined ? `exit ${s.exitCode}` : '')
  } else if (s.status === 'cache-hit' && s.cacheKey) {
    detail = `cache ${s.cacheKey.slice(0, 12)}`
  }
  const suffix = detail !== '' ? ` — ${detail}` : ''
  const line = `${icon} ${s.stepId}${dur}${suffix}`
  if (s.status !== 'failed') {
    return [line]
  }
  return [line, ...stderrTail(s.stderr).map((l) => `    ${l}`)]
}

function totalsLine(report: CheckReport): string {
  const ok = report.steps.filter(
    (s) => s.status === 'succeeded' || s.status === 'cache-hit'
  ).length
  const failed = report.steps.filter((s) => s.status === 'failed').length
  const other = report.steps.length - ok - failed
  const parts = [`${report.steps.length} steps · ${ok} ok`]
  if (failed > 0) {
    parts.push(`${failed} failed`)
  }
  if (other > 0) {
    parts.push(`${other} other`)
  }
  const dur = fmtMs(report.durationMs)
  return `${parts.join(' · ')} — ${dur !== '' ? dur : '?'}`
}

export function renderText(report: CheckReport): string[] {
  const lines = report.steps.flatMap(stepLines)
  lines.push(totalsLine(report))
  if (report.findings !== undefined || report.verdict !== undefined) {
    const verdict = report.verdict !== undefined ? ` · verdict: ${report.verdict}` : ''
    lines.push(`findings: ${report.findings ?? 0}${verdict}`)
  }
  return lines
}

// --- command -------------------------------------------------------------------

function usage(): never {
  console.error(`Usage: bro check [options]

Run the repo's sverka workflow and report per-step stats + findings.

Options:
  --root <dir>       run root (default: cwd)
  --config <path>    sverka config file (sverka --config)
  --entry <id>       entry to run (sverka --entry)
  --executor <name>  host|docker (sverka --executor)
  --evaluate         collect SARIF artifacts + run the policy gate
  --format <fmt>     text (default) | json
  --json             alias for --format json
  -q, --quiet        pass through to sverka
  -v, --verbose      pass through to sverka
  --help             this text

Config (bro.config.json "check"): bin, config, entry, executor, evaluate.
Flags win over config. Exit code mirrors sverka's.`)
  process.exit(2)
}

/** Known argv surface — a typo'd flag (`--evalute`) silently doing
 *  nothing is a usage error, not a pass. Value flags consume the next
 *  token. */
const VALUE_FLAGS = new Set(['--root', '--config', '--entry', '--executor', '--format'])
const BOOL_FLAGS = new Set([
  '--evaluate',
  '--json',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--help',
  '-h',
])

function argError(a: string, kind: 'option' | 'argument'): never {
  console.error(
    `error: ${kind === 'option' ? 'unknown option' : 'unexpected argument'} ${JSON.stringify(a)} — see \`bro check --help\``
  )
  process.exit(2)
}

/** A value flag's value is a separate token — but only when the next
 *  token isn't itself a flag (`--root --json` is a missing value, and
 *  flag() reports it; skipping the flag here would eat that error). */
function nextIsValue(argv: string[], i: number): boolean {
  const a = argv[i]!
  return !a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')
}

function rejectUnknownArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (!a.startsWith('-')) {
      argError(a, 'argument')
    }
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (VALUE_FLAGS.has(name)) {
      if (nextIsValue(argv, i)) {
        i += 1
      }
    } else if (!BOOL_FLAGS.has(a)) {
      argError(a, 'option')
    }
  }
}

interface CheckArgs {
  root: string
  format: 'text' | 'json'
  opts: Parameters<typeof sverkaArgs>[0]
  /** check.bin from config — resolveSverka's first resolution step */
  cfgBin?: string
}

/** argv + the repo's `check` section → run parameters. Usage failures
 *  exit 2 here. Config loads from the run root — `--root <other-repo>`
 *  picks up that repo's section (and node_modules for resolution). */
function parseCheckArgs(argv: string[]): CheckArgs {
  rejectUnknownArgs(argv)
  const root = resolve(flag(argv, '--root') ?? process.cwd())
  const cfg = (loadBroConfig(root).check ?? checkSection(undefined)) as CheckConfig
  const format = flag(argv, '--format') ?? (argv.includes('--json') ? 'json' : 'text')
  if (format !== 'text' && format !== 'json') {
    console.error(`error: --format must be text|json — got ${JSON.stringify(format)}`)
    process.exit(2)
  }
  const executor = flag(argv, '--executor') ?? cfg.executor
  if (
    executor !== undefined &&
    !(CHECK_EXECUTORS as readonly string[]).includes(executor)
  ) {
    console.error(`error: --executor must be host|docker — got ${JSON.stringify(executor)}`)
    process.exit(2)
  }
  return {
    root,
    format,
    opts: {
      config: flag(argv, '--config') ?? cfg.config,
      entry: flag(argv, '--entry') ?? cfg.entry,
      executor,
      evaluate: argv.includes('--evaluate') || cfg.evaluate,
      quiet: argv.includes('-q') || argv.includes('--quiet'),
      verbose: argv.includes('-v') || argv.includes('--verbose'),
    },
    ...(cfg.bin !== undefined ? { cfgBin: cfg.bin } : {}),
  }
}

export function runCheckCommand(argv: string[]): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  const { root, format, opts, cfgBin } = parseCheckArgs(argv)
  const bin = resolveSverka(root, cfgBin)
  if (bin === null) {
    console.error(
      'error: sverka not found — install sverka in the repo (npm i -D sverka), put sverka on PATH, or set "check": {"bin": …} in bro.config.json'
    )
    process.exit(1)
  }

  const { report, data, exitCode } = runCheck(bin, root, opts)
  if (report === undefined || data === undefined) {
    process.exit(exitCode)
  }
  if (format === 'json') {
    // passthrough — sverka's `data` verbatim under bro's envelope name;
    // a projection here would silently drop fields (planId, …)
    console.log(
      JSON.stringify({ command: 'check', data, durationMs: report.durationMs })
    )
  } else {
    for (const line of renderText(report)) {
      console.log(line)
    }
  }
  // process.exitCode, not exit(): a piped --json report can still have
  // buffered stdout writes pending — exiting would truncate it
  process.exitCode = exitCode
}
