/** Real-git fixture shared by command tests: a throwaway repo with one
 *  `main` checkout, plus the chdir-and-clean wrapper, the built-CLI
 *  spawner, and the fake bd/review-host the e2e matrix needs. Test files
 *  must not re-declare these — SonarCloud counts fixture clones as
 *  duplication on new code. */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function git(args: string[], cwd: string): string {
  // a test run inside another repo still carries its repo-location env —
  // strip it so the child only sees the fixture's cwd (GIT_WORK_TREE is
  // the canonical spelling; GIT_WORKTREE is dead text git ignores)
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_INDEX_FILE: _i,
    GIT_COMMON_DIR: _c,
    ...env
  } = process.env
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }) // NOSONAR — PATH lookup is the contract (same as core/git.ts)
}

/** mkdtemp repo → `main` checkout with git identity and one commit.
 *  `seed` may drop files before the commit; without it the commit is
 *  --allow-empty. */
export function initRepo(prefix: string, seed?: (main: string) => void): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const main = join(root, 'main')
  git(['init', '-q', '-b', 'main', main], root)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  seed?.(main)
  git(['add', '-A'], main)
  git(['commit', '-qm', 'init', '--allow-empty'], main)
  return { root, main }
}

/** Run fn in dir, then always restore cwd and delete the repo. */
export function inside<T>(dir: string, root: string, fn: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(prev)
    rmSync(root, { recursive: true, force: true })
  }
}

// --- spawned-CLI e2e fixtures --------------------------------------------------
//
// The dangerous paths (loop auto-merge, hook gates, worktree lifecycle)
// are tested against the BUILT CLI — `npm test` runs after `npm run
// build` in CI, and process.exit paths can't run in-process anyway. No
// bd, no gh, no network: a node shim plays bd (JSON-file store), and an
// external connector plugin plays the review host (state file).

/** The real shipped artifact under test. */
export const CLI_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'index.js'
)

/** Sanitized env for spawned e2e processes — ambient GIT_/BEADS_/DEVIN_/
 *  CLAUDE_/BRO_ vars from the outer agent session must not redirect a
 *  fixture's git dir, hook root, or beads store. Whitelist, not
 *  strip-list: a new leak variable can't sneak in. */
export function e2eEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG']) {
    if (process.env[k] !== undefined) {
      env[k] = process.env[k]!
    }
  }
  return { ...env, ...extra }
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Spawn `node dist/index.js <args>` — the real CLI, pipes captured. */
export function runCli(
  args: string[],
  opts: { cwd: string; input?: string; env?: Record<string, string> }
): CliResult {
  if (!existsSync(CLI_DIST)) {
    throw new Error('packages/cli/dist is missing — run `npm run build` before e2e tests')
  }
  const proc = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: opts.cwd,
    input: opts.input ?? '',
    env: e2eEnv(opts.env),
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    code: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  }
}

/** Minimal `bd` — a JSON-file store behind a node shim, covering the
 *  surface the loop path shells out to. The db path travels via
 *  FAKE_BD_DB (inherited by the CLI's own bd calls AND the spawned
 *  agent's). Unhandled commands fail loudly so a new dependency on a
 *  real bd behavior shows up as a test failure, not a silent pass. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
if (!DB) fail('FAKE_BD_DB unset')
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')) } catch { return { rows: [] } } }
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db))
const args = process.argv.slice(2)
const flags = {}
const pos = []
for (let i = 0; i < args.length; i++) {
  const t = args[i]
  if (t === '--json') continue
  if (t.startsWith('--')) {
    const k = t.slice(2)
    if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) flags[k] = args[++i]
    else flags[k] = true
  } else if (/^-\\w$/.test(t) && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
    flags[t.slice(1)] = args[++i]
  } else pos.push(t)
}
const db = load()
const row = (id) => db.rows.find((r) => r.id === id)
const jsonOut = (v) => { process.stdout.write(JSON.stringify(v) + '\\n') }
const cmd = pos[0]
switch (cmd === undefined && args[0] === '--version' ? '--version' : cmd) {
  case '--version':
    console.log('bd 0.0.0-fake')
    break
  case 'where':
    jsonOut({ path: path.dirname(DB) })
    break
  case 'config':
    if (pos[1] === 'get' && pos[2] === 'issue_prefix') console.log('issue_prefix = fx')
    else if (pos[1] === 'get' && pos[2] === 'actor') console.log('actor = tester')
    else fail('config ' + pos.slice(1).join(' '))
    break
  case 'list': {
    let rows = db.rows
    if (flags.status) rows = rows.filter((r) => r.status === flags.status)
    if (!flags.all) rows = rows.filter((r) => r.status !== 'closed')
    const labs = [].concat(flags.l || [])
    for (const l of labs) rows = rows.filter((r) => (r.labels || []).includes(l))
    // real bd reads -n 0 as unlimited — slice(0,0) would eat every row
    if (flags.n !== undefined && Number(flags.n) > 0) rows = rows.slice(0, Number(flags.n))
    jsonOut(rows)
    break
  }
  case 'ready': {
    const ex = [].concat(flags['exclude-label'] || [])
    const rows = db.rows.filter(
      (r) => r.status === 'open' && !(r.labels || []).some((l) => ex.includes(l))
    )
    rows.sort((a, b) => (a.priority - b.priority) || String(a.created_at).localeCompare(String(b.created_at)))
    jsonOut(rows)
    break
  }
  case 'show': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    jsonOut([r])
    break
  }
  case 'update': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    if (flags.claim === true) {
      if (r.status !== 'open') fail('already claimed: ' + r.id)
      r.status = 'in_progress'
      r.assignee = 'tester'
    } else {
      for (const [k, v] of Object.entries(flags)) {
        if (k === 'json') continue
        r[k] = v === true ? true : v
      }
    }
    save(db)
    break
  }
  case 'close': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    r.status = 'closed'
    if (flags.reason) r.close_reason = flags.reason
    save(db)
    break
  }
  case 'reopen': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    r.status = 'open'
    save(db)
    break
  }
  case 'note': {
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    r.notes = ((r.notes || '') + '\\n' + pos.slice(2).join(' ')).trim()
    save(db)
    break
  }
  case 'merge-slot':
    if (pos[1] === 'acquire') jsonOut({ acquired: true, holder: 'tester' })
    else if (pos[1] === 'check') jsonOut({ available: true, holder: null, waiters: [] })
    else if (pos[1] === 'release') jsonOut({ released: true })
    else if (pos[1] !== 'create') fail('merge-slot ' + pos[1])
    break
  case 'kv': {
    // the learn store's surface — a flat {key: value} map beside rows
    db.kv = db.kv || {}
    const sub = pos[1]
    if (sub === 'set') {
      // missing operands must fail loudly — a silent no-write would
      // green a test while real bd errors
      if (pos[2] === undefined || pos[3] === undefined) fail('kv set <key> <value>')
      db.kv[pos[2]] = pos[3]; save(db)
    }
    else if (sub === 'get') {
      if (db.kv[pos[2]] === undefined) { console.error(pos[2] + ' (not set)'); process.exit(1) }
      console.log(db.kv[pos[2]])
    }
    else if (sub === 'clear') { delete db.kv[pos[2]]; save(db) }
    else if (sub === 'list') { jsonOut(db.kv) }
    else fail('kv ' + sub)
    break
  }
  case 'dep':
    jsonOut([])
    break
  case 'children':
    jsonOut([])
    break
  case 'mol': {
    // learn capture --mol harvests bd mol show — db.mols[id] seeds it
    if (pos[1] !== 'show') fail('mol ' + (pos[1] || ''))
    const m = (db.mols || {})[pos[2]]
    if (!m) fail('no molecule ' + pos[2])
    jsonOut(m)
    break
  }
  case 'delete': {
    const i = db.rows.findIndex((r) => r.id === pos[1])
    if (i >= 0) db.rows.splice(i, 1)
    save(db)
    break
  }
  case 'sync':
    break
  default:
    fail('unhandled: ' + args.join(' '))
}
`

/** Install the fake bd into <dir>/bin and seed its store. Rows take the
 *  `fx-` prefix — the store's configured issue_prefix. */
export function installFakeBd(
  dir: string,
  rows: Array<Record<string, unknown>> = []
): { binDir: string; db: string } {
  const binDir = join(dir, 'bin')
  const db = join(dir, 'beads.json')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'bd'), FAKE_BD)
  chmodSync(join(binDir, 'bd'), 0o755)
  writeBeads(db, rows)
  return { binDir, db }
}

export function writeBeads(
  db: string,
  rows: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): void {
  writeFileSync(db, JSON.stringify({ ...extra, rows }))
}

export function readBeads(db: string): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(db, 'utf8')) as { rows: Array<Record<string, unknown>> }).rows
}

export function bead(db: string, id: string): Record<string, unknown> | undefined {
  return readBeads(db).find((r) => r.id === id)
}

export const FAKE_BEAD = {
  priority: 1,
  issue_type: 'task',
  status: 'open',
  created_at: '2026-01-01T00:00:00Z',
  labels: [] as string[],
}

/** The review-host connector the fixture repo loads as an external
 *  plugin — every facade probe reads host.json so tests and the fake
 *  agent can script the PR lifecycle mid-run (threads cleared by a fix
 *  round, a PR closed under the gate's feet, a merge that reports a
 *  queue hold). */
const FAKE_HOST_PLUGIN = `// e2e fixture — a review-host connector driven by host.json beside this file
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const STATE = join(dirname(fileURLToPath(import.meta.url)), 'host.json')
const load = () => JSON.parse(readFileSync(STATE, 'utf8'))
const save = (s) => writeFileSync(STATE, JSON.stringify(s))
const facade = {
  resolveRepo: () => 'o/r',
  prLink: (_repo, pr) => '[#' + pr + '](https://example.test/o/r/pull/' + pr + ')',
  currentPr: () => null,
  prsForBranch: (branch, state) => {
    const s = load()
    if (s.prLookupFails) throw new Error('host unreachable')
    // per-branch PRs (stack e2e) — {prs: {'stack/s/1-x': {number, state, baseRef}}}
    // the map is authoritative: an unmapped branch has NO PR — falling
    // through to the global prOpened would lend an unrelated PR to a
    // stack branch
    if (s.prs) {
      const p = s.prs[branch]
      if (!p) return []
      if (state === 'all') return [p.number]
      return p.state === 'OPEN' ? [p.number] : []
    }
    return s.prOpened ? [s.pr ?? 7] : []
  },
  parsePrRef: () => null,
  prMeta: (t) => {
    const s = load()
    const per = s.prs
      ? Object.values(s.prs).find((p) => p.number === t.pr) ?? {}
      : {}
    return {
      state: per.state ?? s.prState ?? 'OPEN',
      isDraft: !!(per.isDraft ?? s.isDraft),
      url: 'https://example.test/o/r/pull/' + t.pr,
      headSha: per.headSha ?? s.headSha ?? 'abc123',
      headRef: per.headRef ?? s.headRef ?? 'loop/fx-a',
      baseRef: per.baseRef ?? s.baseRef ?? 'main',
      mergeable: s.mergeable ?? 'MERGEABLE',
      mergeState: s.mergeState ?? 'CLEAN',
    }
  },
  mergedPrInfo: () => { throw new Error('not merged') },
  mergedPrs: () => [],
  checks: () => load().checks ?? [],
  checkAnnotations: () => new Map(),
  reviewedShas: () => load().reviewedShas ?? ['abc123'],
  reviewThreads: async () => load().threads ?? [],
  resolveThread: () => {},
  replyThread: () => {},
  labels: () => [],
  prUpdatedAt: () => null,
  createLabel: () => {},
  addLabel: () => {},
  removeLabel: () => {},
  retargetPr: (t, base) => {
    const s = load()
    s.retargets = (s.retargets ?? []).concat([{ pr: t.pr, base }])
    if (s.prs) {
      for (const p of Object.values(s.prs)) {
        if (p.number === t.pr) p.baseRef = base
      }
    }
    save(s)
    return true
  },
  updateBranch: () => false,
  mergePr: (t) => {
    const s = load()
    s.merges = (s.merges ?? 0) + 1
    s.prState = s.mergeResult ?? 'MERGED'
    // a merge lands on the per-branch entry too — otherwise a mapped
    // stack member keeps reporting OPEN after its merge
    if (s.prs) {
      for (const p of Object.values(s.prs)) {
        if (p.number === t.pr) p.state = s.prState
      }
    }
    save(s)
    return s.prState
  },
}
export default {
  name: 'fakehost-cmd',
  summary: 'e2e fixture',
  run: () => {},
  connectors: [{ name: 'fakehost', matchRemote: () => false, reviews: () => facade }],
}
`

/** The loop's spawned agent — a node script keyed off E2E_SCENARIO and
 *  the prompt file (a '<review-threads>' marker means it was respawned
 *  for a fix round). It commits real work in the worktree and mutates
 *  host.json — the PR exists because the agent "opened" it. */
const FAKE_AGENT = `const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const STATE = process.env.FAKE_HOST_STATE
const promptFile = process.env.BRO_PROMPT_FILE
if (!STATE || !promptFile) {
  console.error('fake agent: FAKE_HOST_STATE and BRO_PROMPT_FILE must be set')
  process.exit(1)
}
const scenario = process.env.E2E_SCENARIO || 'land'
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'))
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s))
const prompt = fs.readFileSync(promptFile, 'utf8')
const log = (msg) => {
  const f = path.join(path.dirname(STATE), 'spawns.log')
  fs.appendFileSync(f, (prompt.includes('review-threads') ? 'fix' : 'work') + ' ' + msg + '\\n')
}
if (prompt.includes('review-threads')) {
  // fix round — resolve the threads and stop
  const s = load()
  s.threads = []
  save(s)
  log('resolved threads')
  process.exit(0)
}
switch (scenario) {
  case 'land': {
    fs.writeFileSync('work.txt', 'did the thing\\n')
    execFileSync('git', ['add', '-A'])
    execFileSync('git', ['commit', '-qm', 'feat: the thing'])
    const s = load()
    s.prOpened = true
    save(s)
    log('opened pr')
    break
  }
  case 'verdict':
    execFileSync('bd', ['close', process.env.BRO_BEAD_ID, '--reason', 'nothing to ship'])
    log('closed bead')
    break
  case 'fail':
    log('dying')
    process.exitCode = 3
    break
  default:
    process.exit(1)
}
`

/** Write the fake review-host plugin, its state file, and the fake agent
 *  into a fixture repo root. Returns the host state path. */
export function installFakeHost(root: string): { state: string; agent: string } {
  writeFileSync(join(root, 'fakehost.ts'), FAKE_HOST_PLUGIN)
  writeFileSync(join(root, 'fake-agent.js'), FAKE_AGENT)
  const state = join(root, 'host.json')
  writeHostState(state, { prOpened: false })
  return { state, agent: join(root, 'fake-agent.js') }
}

export function readHostState(state: string): Record<string, unknown> {
  return JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>
}

export function writeHostState(state: string, patch: Record<string, unknown>): void {
  const cur = existsSync(state)
    ? (JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>)
    : {}
  writeFileSync(state, JSON.stringify({ ...cur, ...patch }))
}
