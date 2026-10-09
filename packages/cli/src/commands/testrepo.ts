/** Real-git fixture shared by command tests: a throwaway repo with one
 *  `main` checkout, plus the chdir-and-clean wrapper, the built-CLI
 *  spawner, and the fake bd/review-host the e2e matrix needs. Test files
 *  must not re-declare these — SonarCloud counts fixture clones as
 *  duplication on new code. */
import assert from 'node:assert/strict'
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

/** Async inside() — the cleanup must await the body: deleting the repo
 *  while a returned promise still probes it turns the test into a race. */
export async function insideAsync<T>(dir: string, root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
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
 *  CLAUDE_/CURSOR_/BRO_ vars from the outer agent session must not redirect a
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
    const k = t.slice(1)
    flags[k] = flags[k] === undefined ? args[++i] : [].concat(flags[k], args[++i])
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
    else if (pos[1] === 'get' && pos[2] === 'types.custom') console.log((db.cfg || {})['types.custom'] || '')
    else if (pos[1] === 'set') { db.cfg = db.cfg || {}; db.cfg[pos[2]] = pos[3]; save(db) }
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
  case 'create': {
    const id = 'fx-' + Math.random().toString(36).slice(2, 8)
    db.rows.push({
      id,
      title: flags.title || '',
      description: flags.description || '',
      status: 'open',
      priority: Number(flags.priority ?? 2),
      issue_type: flags.type || 'task',
      labels: flags.labels !== undefined ? String(flags.labels).split(',') : [],
      created_at: new Date().toISOString(),
    })
    save(db)
    jsonOut({ id })
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
        if (k === 'set-labels' || k === 'add-label') { r.labels = String(v).split(',') }
        else if (k === 'external-ref') { r.external_ref = v }
        else r[k] = v === true ? true : v
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
  case 'dep': {
    // dep add <id> <to> — records the edge verbatim (external:<…>:<…>
    // refs included) so tests can assert dep wiring happened
    if (pos[1] === 'add') {
      if (pos[2] === undefined || pos[3] === undefined) fail('dep add <id> <to>')
      const r = row(pos[2])
      if (!r) fail('not found: ' + pos[2])
      db.deps = db.deps || []
      db.deps.push({ from: pos[2], to: pos[3] })
      save(db)
      break
    }
    jsonOut(db.deps || [])
    break
  }
  case 'children':
    jsonOut([])
    break
  case 'mol': {
    // learn capture --mol harvests bd mol show — db.mols[id] seeds it;
    // convoy/sweep pours a generated formula — a root row + the line
    // pourFormula parses is the contract
    if (pos[1] === 'pour') {
      const id = 'fx-mol-' + (db.rows.length + 1)
      db.rows.push({ id, title: pos[2], status: 'open', issue_type: 'epic' })
      save(db)
      console.log('Root issue: ' + id)
      break
    }
    if (pos[1] !== 'show') fail('mol ' + (pos[1] || ''))
    const m = (db.mols || {})[pos[2]]
    if (!m) fail('no molecule ' + pos[2])
    jsonOut(m)
    break
  }
  case 'set-state': {
    // dim=value → label dim:value (drop the dimension's old label first)
    const r = row(pos[1])
    if (!r) fail('not found: ' + pos[1])
    const eq = (pos[2] || '').indexOf('=')
    if (eq < 0) fail('set-state <id> dim=value')
    const dim = pos[2].slice(0, eq), val = pos[2].slice(eq + 1)
    r.labels = (r.labels || []).filter((l) => !l.startsWith(dim + ':'))
    r.labels.push(dim + ':' + val)
    save(db)
    break
  }
  case 'export': {
    const lines = db.rows.filter((r) => r.ephemeral !== true).map((r) => JSON.stringify(r))
    const out = lines.join('\\n') + (lines.length ? '\\n' : '')
    if (flags.o) { require('node:fs').writeFileSync(flags.o, out) }
    else process.stdout.write(out)
    break
  }
  case 'provenance': {
    if (pos[1] !== 'log') fail('provenance ' + (pos[1] || ''))
    if ((db.provFail || []).includes(pos[2])) fail('provenance log failed')
    jsonOut((db.prov || {})[pos[2]] || [])
    break
  }
  case 'prune': {
    const m = /^(\\d+)d$/.exec(flags['older-than'] || '')
    const days = m ? Number(m[1]) : 0
    const cut = Date.now() - days * 86400000
    const drop = (r) => r.status === 'closed' && r.ephemeral !== true &&
      Date.parse(r.closed_at || '') < cut
    const n = db.rows.filter(drop).length
    if (!flags.force && !flags['dry-run']) { console.log(n + ' bead(s) would prune'); break }
    db.rows = db.rows.filter((r) => !drop(r))
    save(db)
    console.log('Pruned ' + n + ' issue(s)')
    break
  }
  case 'flatten':
    console.log('flattened')
    break
  case 'info':
    jsonOut({ database_path: path.join(path.dirname(DB), 'beads.db') })
    break
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

/** The landed-claim verdict every act settle path owes — the bead is
 *  closed with the merge link as its close reason; stderr (when the
 *  caller holds one) carries the `act: <id> closed` line. */
export function assertLandedBead(db: string, id: string, stderr?: string): void {
  if (stderr !== undefined) {
    assert.match(stderr, new RegExp(`${id} closed`))
  }
  const row = bead(db, id)
  assert.equal(row?.status, 'closed')
  assert.match(String(row?.close_reason), /landed via/)
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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
      mergeable: per.mergeable ?? s.mergeable ?? 'MERGEABLE',
      mergeState: per.mergeState ?? s.mergeState ?? 'CLEAN',
    }
  },
  mergedPrInfo: () => { throw new Error('not merged') },
  mergedPrs: () => [],
  checks: (t) => {
    const s = load()
    // mid-poll snapshot of the watch-marker dir — a waitForGate caller
    // that armed watch: holds the marker for the fetch's duration, so
    // the loop's gate wait is observable exactly like act wait's
    try {
      const wd = join(process.cwd(), '.git', 'bro', 'watches')
      s.watchPeeks = (s.watchPeeks ?? []).concat(
        readdirSync(wd)
          .filter((f) => f.endsWith('.json'))
          .map((f) => ({ file: f, marker: JSON.parse(readFileSync(join(wd, f), 'utf8')) }))
      )
      save(s)
    } catch {}
    // per-PR checks — a mapped entry carries its own check list (with a
    // clearAfterMerge trigger: once that PR lands in events, this one's
    // checks go green — the round-robin "A pending while B merges" cue)
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        if (
          p.clearAfterMerge !== undefined &&
          (s.events ?? []).some((e) => e.merge === p.clearAfterMerge)
        ) {
          p.checks = []
          save(s)
        }
        return p.checks ?? s.checks ?? []
      }
    }
    return s.checks ?? []
  },
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
  updateBranch: (t) => {
    const s = load()
    if (s.updateFails) return false
    s.events = (s.events ?? []).concat([{ update: t.pr }])
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.mergeState = 'CLEAN'
        p.headSha = 'updated-' + t.pr
        save(s)
        return true
      }
    }
    s.mergeState = 'CLEAN'
    s.headSha = 'updated-' + t.pr
    save(s)
    return true
  },
  mergePr: (t) => {
    const s = load()
    s.merges = (s.merges ?? 0) + 1
    s.events = (s.events ?? []).concat([{ merge: t.pr }])
    // a merge lands on the per-branch entry too — otherwise a mapped
    // stack member keeps reporting OPEN after its merge
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.state = p.mergeResult ?? s.mergeResult ?? 'MERGED'
        save(s)
        return p.state
      }
    }
    s.prState = s.mergeResult ?? 'MERGED'
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
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
// stdout line — proves the loop's spawn tee lands agent output in the
// run record's <slug>.log, not the loop's own stream (bro-9lpn3)
console.log('agent ' + scenario + ' on ' + (process.env.BRO_BEAD_ID || '?'))
const log = (msg) => {
  const f = path.join(path.dirname(STATE), 'spawns.log')
  const kind = prompt.includes('review-threads')
    ? 'fix'
    : prompt.includes('merge conflicts')
      ? 'rebase'
      : 'work'
  fs.appendFileSync(f, kind + ' ' + msg + '\\n')
}
if (prompt.includes('review-threads')) {
  // fix round — resolve the threads and stop
  const s = load()
  s.threads = []
  save(s)
  log('resolved threads')
  process.exit(0)
}
if (prompt.includes('merge conflicts')) {
  // rebase round — clear the conflict and stop
  const s = load()
  s.mergeable = 'MERGEABLE'
  if (s.prs?.[branch]) s.prs[branch].mergeable = 'MERGEABLE'
  s.events = (s.events ?? []).concat([{ rebase: process.env.BRO_BEAD_ID || null, branch }])
  save(s)
  log('rebased onto base')
  process.exit(0)
}
switch (scenario) {
  case 'land': {
    fs.writeFileSync('work.txt', 'did the thing\\n')
    execFileSync('git', ['add', '-A'])
    execFileSync('git', ['commit', '-qm', 'feat: the thing'])
    const s = load()
    s.events = (s.events ?? []).concat([{ spawn: process.env.BRO_BEAD_ID || null, branch }])
    // the per-branch map (seeded prs: {}) is authoritative when present
    if (s.prs) {
      s.prs[branch] = {
        ...(s.prs[branch] ?? {}),
        number: s.prs[branch]?.number ?? (s.nextPr = (s.nextPr ?? 10) + 1),
        state: 'OPEN',
        headRef: branch,
        baseRef: 'main',
      }
    }
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
  case 'hang':
    // the silent-death shape — an agent that never returns; the loop
    // must stay alive behind its heartbeat, not vanish
    log('hanging forever')
    setInterval(() => {}, 60_000)
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

/** A `tasks` connector over tasks.json beside the plugin — the
 *  configured-backend fixture half: `connectors.tasks` pins it and the
 *  facade's TaskStore ops land on this file instead of `bd`. Only the
 *  surface the bead-close path needs is implemented. */
const FAKE_TASKS_PLUGIN = `// e2e fixture — a tasks connector driven by tasks.json beside this file
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const DB = join(dirname(fileURLToPath(import.meta.url)), 'tasks.json')
const load = () => JSON.parse(readFileSync(DB, 'utf8'))
const save = (db) => writeFileSync(DB, JSON.stringify(db))
export default {
  name: 'faketasks-plugin',
  summary: 'e2e fixture',
  run: () => {},
  connectors: [
    {
      name: 'faketasks',
      matchRemote: () => false,
      tasks: () => ({
        get: (id) => load().rows.find((r) => r.id === id),
        close: (id, reason) => {
          const db = load()
          const r = db.rows.find((x) => x.id === id)
          if (r) {
            r.status = 'closed'
            if (reason) r.close_reason = reason
            save(db)
          }
        },
      }),
    },
  ],
}
`

/** Write the fake tasks-connector plugin + its store into the fixture
 *  repo root; `db` is the tasks.json path `bead()` can read. */
export function installFakeTasks(
  root: string,
  rows: Array<Record<string, unknown>> = []
): { db: string } {
  writeFileSync(join(root, 'faketasks.ts'), FAKE_TASKS_PLUGIN)
  const db = join(root, 'tasks.json')
  writeBeads(db, rows)
  return { db }
}

// --- fake dolt — the beads-remote transport fixture -----------------------------
//
// `dolt clone <remote> <dir>` copies the remote's `db.json` into the
// replica's `.dolt/`; `dolt pull` re-copies it (the publish refresh);
// `dolt sql -q <q> -r json` answers the two queries mesh pulls run
// (mesh-labelled issues, labels-per-issue) from that file. The remote
// store is a plain directory holding `db.json` — the fixture stands in
// for `refs/dolt/data` on a git remote.

const FAKE_DOLT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const fail = (m) => { console.error('fake dolt: ' + m); process.exit(1) }
const storeDir = process.cwd()
const storeFile = path.join(storeDir, '.dolt', 'db.json')
const load = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'))
const args = process.argv.slice(2)
switch (args[0]) {
  case 'clone': {
    const src = path.join(args[1], 'db.json')
    const dst = args[2]
    fs.mkdirSync(path.join(dst, '.dolt'), { recursive: true })
    fs.copyFileSync(src, path.join(dst, '.dolt', 'db.json'))
    fs.writeFileSync(path.join(dst, '.dolt', 'remote'), args[1])
    break
  }
  case 'pull': {
    const src = fs.readFileSync(path.join(storeDir, '.dolt', 'remote'), 'utf8').trim()
    fs.copyFileSync(path.join(src, 'db.json'), storeFile)
    break
  }
  case 'sql': {
    const q = args[args.indexOf('-q') + 1]
    const db = load()
    // order matters: the mesh-issues query contains a "from labels"
    // subquery too — the per-issue query is the only "select label"
    if (q.includes('select label')) {
      const id = /issue_id = '([^']+)'/.exec(q)[1]
      const issue = db.issues.find((i) => i.id === id)
      const rows = (issue?.labels || []).map((label) => ({ label }))
      process.stdout.write(JSON.stringify({ rows }))
    } else if (q.includes('from issues')) {
      const want = /label = '([^']+)'/.exec(q)[1]
      const rows = db.issues
        .filter((i) => (i.labels || []).includes(want))
        .map(({ labels: _l, ...rest }) => rest)
      process.stdout.write(JSON.stringify({ rows }))
    } else fail('sql ' + q)
    break
  }
  default:
    fail(args[0])
}
`

/** A bare "published dolt store" a peer would expose: `dir/db.json`
 *  holding `issues` rows with inline `labels`. Returns dir + a `publish`
 *  that rewrites it (what `bd dolt push` models). */
export function installFakeDoltRemote(
  dir: string,
  issues: Array<Record<string, unknown>>
): { remoteDir: string; publish: (issues: Array<Record<string, unknown>>) => void } {
  const remoteDir = join(dir, 'remote-dolt')
  mkdirSync(remoteDir, { recursive: true })
  const publish = (rows: Array<Record<string, unknown>>) =>
    writeFileSync(join(remoteDir, 'db.json'), JSON.stringify({ issues: rows }))
  publish(issues)
  return { remoteDir, publish }
}

/** Put the fake `dolt` binary next to a fake `bd` binDir (or alone). */
export function installFakeDolt(dir: string): string {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'dolt'), FAKE_DOLT)
  chmodSync(join(binDir, 'dolt'), 0o755)
  return binDir
}

export function writeHostState(state: string, patch: Record<string, unknown>): void {
  const cur = existsSync(state)
    ? (JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>)
    : {}
  writeFileSync(state, JSON.stringify({ ...cur, ...patch }))
}
