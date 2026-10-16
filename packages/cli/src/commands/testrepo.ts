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
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ambient env that must not reach a fixture's git children. The
 *  repo-location pins retarget the child outright; the GIT_CONFIG*
 *  family (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS)
 *  injects config — a pinned core.hooksPath would run host hooks on
 *  fixture commits — and GIT_TEMPLATE_DIR plants hook files at init. */
const AMBIENT_GIT =
  /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_CONFIG($|_)|GIT_TEMPLATE_DIR$)/

export function git(args: string[], cwd: string): string {
  // a test run inside another repo still carries its repo-location env —
  // strip it so the child only sees the fixture's cwd (GIT_WORK_TREE is
  // the canonical spelling; GIT_WORKTREE is dead text git ignores).
  // Global/system config files get nulled too: a host ~/.gitconfig
  // core.hooksPath (or commit.gpgsign, init.defaultBranch) is the same
  // leak through a file instead of a var
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !AMBIENT_GIT.test(k))
  ) as NodeJS.ProcessEnv
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = devNull
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }) // NOSONAR — PATH lookup is the contract (same as core/git.ts)
}

/** mkdtemp repo → `main` checkout with git identity and one commit.
 *  `seed` may drop files before the commit; without it the commit is
 *  --allow-empty. */
export function initRepo(prefix: string, seed?: (main: string) => void): { root: string; main: string } {
  const root = tmpDir(prefix)
  const main = join(root, 'main')
  git(['init', '-q', '-b', 'main', main], root)
  git(['config', 'user.email', 't@t'], main)
  git(['config', 'user.name', 't'], main)
  seed?.(main)
  git(['add', '-A'], main)
  git(['commit', '-qm', 'init', '--allow-empty'], main)
  return { root, main }
}

/** mkdtemp under a per-process sweep: dirs made here are deleted when
 *  the test process exits, pass or fail — the 'one root with a sweep'
 *  half of the fixture-leak contract (initRepo callers get the same
 *  guarantee through inside()/insideAsync). Use this for fixture dirs
 *  that are NOT wrapped in a try/finally rmSync of their own. */
const tmpDirs: string[] = []
let tmpSweepArmed = false
export function tmpDir(prefix: string): string {
  if (!tmpSweepArmed) {
    tmpSweepArmed = true
    process.once('exit', () => {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    })
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
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
  // the whitelist drops even a file-scope scrub's null-config pins —
  // HOME rides along, so without these the child's git reads the host
  // ~/.gitconfig (core.hooksPath, commit.gpgsign) on fixture commits
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = devNull
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
const ENV_DB = process.env.FAKE_BD_DB
const fail = (m) => { console.error('fake bd: ' + m); process.exit(1) }
if (!ENV_DB) fail('FAKE_BD_DB unset')
// transient fs hiccups (EMFILE/EAGAIN on a loaded CI runner) must not
// read as an empty store or kill a bd call — retry first (bro-6u1tu)
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retry = (fn) => {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i > 40) throw e
      pause(25)
    }
  }
}
const load = () => {
  try { return retry(() => JSON.parse(fs.readFileSync(DB, 'utf8'))) } catch { return { rows: [] } }
}
const save = (db) => retry(() => {
  // tmp+rename — a worker's own 'bd close' racing the loop's calls must
  // never hand a reader a torn store
  const tmp = DB + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(db))
  fs.renameSync(tmp, DB)
})
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
// real bd resolves BEADS_DIR BEFORE directory discovery — an ambient
// pin wins over both -C and cwd. A checkout carrying .beads/beads.json
// gets its own store under discovery; anything else falls back to the
// env-pinned db (the single-store fixture)
const dir = flags.C || process.cwd()
const ownDb = path.join(dir, '.beads', 'beads.json')
const DB = process.env.BEADS_DIR
  ? path.join(process.env.BEADS_DIR, 'beads.json')
  : fs.existsSync(ownDb) ? ownDb : ENV_DB
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
    if (flags.deferred) rows = rows.filter((r) => r.defer_until)
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
    // real bd answers found rows for every id — a partial miss omits
    // the miss (stderr warn, exit 0); a TOTAL multi-id miss exits 0
    // with an {error} envelope while a single miss exits 1
    const ids = pos.slice(1)
    const found = ids.map((id) => row(id)).filter(Boolean)
    if (found.length === 0) {
      if (ids.length > 1) {
        jsonOut({ error: 'no issues found matching the provided IDs', schema_version: 1 })
      } else {
        fail('Issue ' + ids[0] + ' not found')
      }
      break
    }
    for (const id of ids) {
      if (!row(id)) console.error('Issue ' + id + ' not found')
    }
    jsonOut(found)
    break
  }
  case 'create': {
    const id = 'fx-' + Math.random().toString(36).slice(2, 8)
    // real bd emits short flags (-d/-t/-p/-l) as often as long ones —
    // read both spellings or the row silently loses them
    const short = (k) => flags[k] ?? flags[k[0]]
    db.rows.push({
      id,
      title: flags.title || '',
      description: short('description') || '',
      status: 'open',
      priority: Number(short('priority') ?? 2),
      issue_type: short('type') || 'task',
      labels: short('labels') !== undefined ? String(short('labels')).split(',') : [],
      external_ref: flags['external-ref'],
      created_at: new Date().toISOString(),
    })
    // --parent is a dep edge, not a field — record it so drill/queue
    // promote paths keep the child↔frame link real bd would write
    if (flags.parent) {
      db.deps = db.deps || []
      db.deps.push({ issue_id: id, depends_on_id: flags.parent, type: 'parent' })
    }
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
      r.updated_at = new Date().toISOString()
    } else {
      for (const [k, v] of Object.entries(flags)) {
        if (k === 'json') continue
        if (k === 'set-labels') { r.labels = String(v).split(',') }
        // real bd: add-label appends, remove-label drops — repeatable
        // flags arrive as an array from the arg scan above
        else if (k === 'add-label') { r.labels = [...new Set([...(r.labels || []), ...[].concat(v)])] }
        else if (k === 'remove-label') {
          const drop = new Set([].concat(v))
          r.labels = (r.labels || []).filter((l) => !drop.has(l))
        }
        else if (k === 'external-ref') { r.external_ref = v }
        // --defer <ts> is the snooze: defer_until + deferred status,
        // hidden from ready until a wake (real bd semantics)
        else if (k === 'defer') { r.defer_until = v; r.status = 'deferred' }
        else r[k] = v === true ? true : v
      }
      // real bd stamps updated_at on every write — LIFO and
      // most-recently-touched ordering depend on it
      r.updated_at = new Date().toISOString()
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
  case 'undefer': {
    // bd undefer <id>… — the snooze's release: back to open, defer_until
    // cleared; the assignee survives (real bd keeps it)
    for (const id of pos.slice(1)) {
      const r = row(id)
      if (!r) fail('not found: ' + id)
      r.status = 'open'
      delete r.defer_until
    }
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
  case 'ship': {
    // real bd: finds the issue by its export:<cap> label, refuses an
    // open one unless --force, then pins provides:<cap>
    const cap = pos[1]
    if (cap === undefined) fail('ship <capability>')
    const r = db.rows.find((x) => (x.labels || []).includes('export:' + cap))
    if (!r) fail('no issue found with export:' + cap + ' label')
    if (r.status !== 'closed' && flags.force !== true) {
      fail('issue ' + r.id + ' is not closed — use --force to override')
    }
    r.labels = [...new Set([...(r.labels || []), 'provides:' + cap])]
    save(db)
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
    if (pos[1] === 'wisp' && pos[2] === 'list') { jsonOut({ wisps: db.wisps || [] }); break }
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
    if (pos[1] === 'record') {
      db.prov = db.prov || {}
      const id = flags.issue
      db.prov[id] = [...(db.prov[id] || []), { kind: flags.kind, source: flags.source, ref: flags.ref }]
      save(db)
      break
    }
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

/** A healthy-empty docker for fixtures on docker-less hosts — `version`
 *  answers, `ps` lists nothing, anything else is a 'No such object'
 *  failure. docker is a registered agents backend: fixtures that assert
 *  a 'gone' verdict need every backend healthy, or the plane degrades
 *  and the verdict flips to 'unverified'. Tests that exercise a broken
 *  daemon overwrite this stub in their own binDir. */
const FAKE_DOCKER = `#!/bin/sh
if [ "$1" = version ]; then echo "25.0.0-fake"; exit 0; fi
if [ "$1" = ps ]; then exit 0; fi
echo "Error: No such object" >&2; exit 1
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
  writeFileSync(join(binDir, 'docker'), FAKE_DOCKER)
  chmodSync(join(binDir, 'docker'), 0o755)
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

/** Test-side read with the same CI-jitter shield the embedded fakes
 *  carry — a transient EMFILE/EAGAIN on a loaded runner must not fail
 *  an assertion path (bro-6u1tu). ~1s of retries, then it throws. */
function readJsonRetry(path: string): unknown {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      if (i > 40) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

export function readBeads(db: string): Array<Record<string, unknown>> {
  return (readJsonRetry(db) as { rows: Array<Record<string, unknown>> }).rows
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
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const STATE = join(dirname(fileURLToPath(import.meta.url)), 'host.json')
// a transient fs hiccup (EMFILE/EAGAIN on a loaded CI runner) must not
// read as a dead host — a one-shot load throw settles as 'lookup-error'
// and parks a member whose PR exists (the batch e2e's '4 landed'
// flake, bro-6u1tu). ~1s of retries; a deterministic bad state still
// throws, just late.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retry = (fn) => {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i > 40) throw e
      pause(25)
    }
  }
}
const load = () => retry(() => JSON.parse(readFileSync(STATE, 'utf8')))
// host.json is shared by this process and every detached worker — a
// read-modify-write needs a cross-process critical section (mkdir is
// atomic), and every write goes through tmp+rename so a reader never
// sees a torn file. Without it the batch e2e flakes: a stale save
// resurrects a merged PR and concurrent spawns clobber each other's
// events.
const LOCK = STATE + '.lock'
const save = (s) => {
  const tmp = STATE + '.tmp.' + process.pid
  retry(() => {
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, STATE)
  })
}
const withState = (fn) => {
  for (let i = 0; ; i++) {
    try { mkdirSync(LOCK); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (i > 2000) throw new Error('host state lock wedged')
      pause(5)
    }
  }
  try { const s = load(); const r = fn(s); save(s); return r }
  finally { rmSync(LOCK, { recursive: true, force: true }) }
}
// the loop run-record plane, snapshotted in-band (bro-wg896): the
// registry path must leave bro/loop/<slug>.json live while a worker
// runs and through the findPr settle window, retiring it once the
// armed watch marker owns custody — prsForBranch catches the settle
// read, checks the post-arm gate polls
const peekLoop = (s, at) => {
  const recs = {}
  try {
    const ld = join(process.cwd(), '.git', 'bro', 'loop')
    for (const f of readdirSync(ld).filter((f) => f.endsWith('.json'))) {
      recs[f.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(ld, f), 'utf8'))
    }
  } catch { /* no loop dir = an empty plane — still a real peek */ }
  s.loopPeeks = (s.loopPeeks ?? []).concat([{ at, records: recs }])
}
const facade = {
  resolveRepo: () => 'o/r',
  prLink: (_repo, pr) => '[#' + pr + '](https://example.test/o/r/pull/' + pr + ')',
  currentPr: () => null,
  prsForBranch: (branch, state) => withState((s) => {
    if (s.prLookupFails) throw new Error('host unreachable')
    peekLoop(s, 'pr-lookup')
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
  }),
  parsePrRef: () => null,
  prMeta: (t) => withState((s) => {
    // readQueues.meta — the same mid-flight race scripting as
    // readQueues.checks: each call shifts one partial-meta overlay, so a
    // test can script 'OPEN + head aaa at the gate, MERGED (or a moved
    // head) at the fixer's own re-probe'
    let over = {}
    const mq = s.readQueues?.meta
    if (Array.isArray(mq) && mq.length > 0) {
      s.readQueues.meta = mq.slice(1)
      over = mq[0] ?? {}
    }
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
      ...over,
    }
  }),
  mergedPrInfo: () => { throw new Error('not merged') },
  mergedPrs: () => [],
  checks: (t) => withState((s) => {
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
      peekLoop(s, 'gate')
    } catch {}
    // a readQueues.checks list overrides everything — each call shifts
    // one entry, so a test can script 'red at the gate snapshot, green
    // at the fixer re-probe' (the mid-flight resolution race, bro-atb2g)
    const cq = s.readQueues?.checks
    if (Array.isArray(cq) && cq.length > 0) {
      s.readQueues.checks = cq.slice(1)
      return cq[0]
    }
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
        }
        return p.checks ?? s.checks ?? []
      }
    }
    return s.checks ?? []
  }),
  checkAnnotations: (_repo, sha, names) => withState((s) => {
    // record the sha each probe targeted — a fixer re-probe on a moved
    // head must read the LIVE sha, never the gate's stale one
    s.annotationReads = (s.annotationReads ?? []).concat([sha])
    // readQueues.annotations — each call shifts one map (the same
    // mid-flight race scripting as readQueues.checks)
    const aq = s.readQueues?.annotations
    let all = s.annotations ?? {}
    if (Array.isArray(aq) && aq.length > 0) {
      s.readQueues.annotations = aq.slice(1)
      all = aq[0] ?? {}
    }
    // names-given callers read exactly that set — an unrequested check
    // never appears (absent key = no annotations endpoint, like gh).
    // An explicit null is the fake's 'fetch failed' — it passes through
    // as sast_unknown; an absent name is a clean read
    const keys = names ? [...names] : Object.keys(all)
    return new Map(keys.map((k) => [k, Object.hasOwn(all, k) ? all[k]! : 0]))
  }),
  reviewedShas: () => load().reviewedShas ?? ['abc123'],
  reviewThreads: async () => load().threads ?? [],
  resolveThread: () => {},
  replyThread: () => {},
  // per-PR labels/body — the prs map's entries carry them; the flat
  // single-PR path uses s.labels/s.prBody (spec bro-c650l ownership)
  labels: (t) => {
    const s = load()
    if (s.labelsThrow) throw new Error('labels endpoint down')
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) return p.labels ?? []
    }
    return s.labels ?? []
  },
  prUpdatedAt: () => null,
  prBody: (t) => {
    const s = load()
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) return p.body ?? ''
    }
    return s.prBody ?? ''
  },
  updatePrBody: (t, body) => withState((s) => {
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.body = body
        return
      }
    }
    s.prBody = body
  }),
  createLabel: () => {},
  addLabel: (t, label) => withState((s) => {
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.labels = (p.labels ?? []).concat(label)
        return
      }
    }
    s.labels = (s.labels ?? []).concat(label)
  }),
  removeLabel: (t, label) => withState((s) => {
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.labels = (p.labels ?? []).filter((l) => l !== label)
        return
      }
    }
    s.labels = (s.labels ?? []).filter((l) => l !== label)
  }),
  retargetPr: (t, base) => withState((s) => {
    s.retargets = (s.retargets ?? []).concat([{ pr: t.pr, base }])
    if (s.prs) {
      for (const p of Object.values(s.prs)) {
        if (p.number === t.pr) p.baseRef = base
      }
    }
    return true
  }),
  updateBranch: (t) => withState((s) => {
    if (s.updateFails) return false
    s.events = (s.events ?? []).concat([{ update: t.pr }])
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.mergeState = 'CLEAN'
        p.headSha = 'updated-' + t.pr
        return true
      }
    }
    s.mergeState = 'CLEAN'
    s.headSha = 'updated-' + t.pr
    return true
  }),
  mergePr: (t) => withState((s) => {
    s.merges = (s.merges ?? 0) + 1
    s.events = (s.events ?? []).concat([{ merge: t.pr }])
    // merge order is asserted in stack e2e — per-layer must go bottom→top
    s.mergeLog = (s.mergeLog ?? []).concat([t.pr])
    // a merge lands on the per-branch entry too — otherwise a mapped
    // stack member keeps reporting OPEN after its merge
    if (s.prs) {
      const p = Object.values(s.prs).find((p) => p.number === t.pr)
      if (p) {
        p.state = p.mergeResult ?? s.mergeResult ?? 'MERGED'
        return p.state
      }
    }
    s.prState = s.mergeResult ?? 'MERGED'
    return s.prState
  }),
}
// the stacks facade — host.json cascade: {retarget, rebase} scripts
// platform ownership for every PR-carrying member (GitLab-style
// retarget-only, GitHub-style retarget+remote-rebase). The stacks map
// is the host's stack registry: publish writes branch → stack id for
// every member, growing a shared id when some already belong;
// membership reads it back. Only claimed via connectors.stacks — the
// git connector's dir match wins unnamed.
const stacksFacade = {
  openHint: (m) => 'fake-mr create --base ' + m.base,
  cascade: (m) => {
    const s = load()
    return s.cascade !== undefined && m.pr !== undefined
      ? s.cascade
      : { retarget: false, rebase: false }
  },
  membership: (m) => {
    const id = load().stacks?.[m.branch]
    return id === undefined ? null : { id }
  },
  publish: (members) => withState((s) => {
    // publishGap scripts the unproven-publish shape — link "ran" but
    // the membership readback reports nothing, so the stack registry
    // stays empty and the verb returns null
    if (s.publishGap) {
      return null
    }
    s.stacks = s.stacks ?? {}
    const existing = members.map((m) => s.stacks[m.branch]).find((i) => i !== undefined)
    const id = existing ?? (s.nextStackId = (s.nextStackId ?? 900) + 1)
    for (const m of members) {
      s.stacks[m.branch] = id
    }
    return { id, size: members.length }
  }),
}
export default {
  name: 'fakehost-cmd',
  summary: 'e2e fixture',
  run: () => {},
  connectors: [{ name: 'fakehost', matchRemote: () => false, reviews: () => facade, stacks: () => stacksFacade }],
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
// a transient fs/spawn hiccup (EMFILE/EAGAIN on a loaded CI runner)
// must not kill the worker — an early exit-1 parks a good bead as a
// 'crash' (the batch e2e's '4 landed' flake, bro-6u1tu). ~1s of
// retries; a deterministic failure still dies, just late.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retry = (fn) => {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i > 40) throw e
      pause(25)
    }
  }
}
const load = () => retry(() => JSON.parse(fs.readFileSync(STATE, 'utf8')))
// same host.json contract as the plugin: workers are detached and the
// CLI probes mid-run, so mutations serialize on a mkdir lock and writes
// go through tmp+rename — an unlocked read-modify-write was the batch
// e2e's flake source (lost spawn events, resurrected PR state)
const LOCK = STATE + '.lock'
const save = (s) => {
  const tmp = STATE + '.tmp.' + process.pid
  retry(() => {
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, STATE)
  })
}
const withState = (fn) => {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (i > 2000) throw new Error('host state lock wedged')
      pause(5)
    }
  }
  try { const s = load(); const r = fn(s); save(s); return r }
  finally { fs.rmSync(LOCK, { recursive: true, force: true }) }
}
// retry only spawn hiccups (EMFILE/EAGAIN — the error carries e.code
// and no exit status): the command never ran. A non-zero exit means it
// ran to completion — re-running a non-idempotent op ('git commit' →
// 'nothing to commit') would read a landed commit as a crash
const sh = (cmd, args) => {
  for (let i = 0; ; i++) {
    try { return execFileSync(cmd, args, { encoding: 'utf8' }) } catch (e) {
      if (e.code === undefined || i > 40) throw e
      pause(25)
    }
  }
}
const prompt = retry(() => fs.readFileSync(promptFile, 'utf8'))
const branch = sh('git', ['branch', '--show-current']).trim()
// stdout line — proves the loop's spawn tee lands agent output in the
// run record's <slug>.log, not the loop's own stream (bro-9lpn3)
console.log('agent ' + scenario + ' on ' + (process.env.BRO_BEAD_ID || '?'))
const log = (msg) => {
  const f = path.join(path.dirname(STATE), 'spawns.log')
  const kind = prompt.includes('review-threads')
    ? 'fix'
    : prompt.includes('merge conflicts')
      ? 'rebase'
      : prompt.includes('CI fixer')
        ? 'ci'
        : prompt.includes('SAST fixer')
          ? 'sast'
          : 'work'
  // provider/class provenance pins the loop sets — routing tests key
  // off them; the bracket suffix keeps the 'work opened pr' match intact
  const prov = ' [bead=' + (process.env.BRO_BEAD_ID || '-') +
    ' provider=' + (process.env.BRO_AGENT_PROVIDER || '-') +
    ' class=' + (process.env.BRO_AGENT_CLASS || '-') + ']'
  retry(() => fs.appendFileSync(f, kind + ' ' + msg + prov + '\\n'))
}
// in-band run-record peek (bro-wg896): the detached worker can't ask
// the loop mid-tick, so it snapshots bro/loop/ itself — the cwd is
// the worktree, whose .git is a file, so the common dir resolves via
// git. A registry-path spawn must leave a live record while it runs.
const peekLoop = (at) => {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }
    ).trim()
    const ld = path.join(common, 'bro', 'loop')
    const recs = {}
    for (const f of fs.readdirSync(ld).filter((f) => f.endsWith('.json'))) {
      recs[f.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(ld, f), 'utf8'))
    }
    const s = load()
    s.loopPeeks = (s.loopPeeks ?? []).concat([{ at, records: recs }])
    save(s)
  } catch {}
}
// spawn resolves after the fork — the first peek may still see the
// claim-custody stamp; the scenario-end peek reads the worker stamp
peekLoop('worker-start')
// register the "opened" PR — the per-branch map (seeded prs: {}) is
// authoritative when present; the flat prOpened flag feeds the legacy
// single-PR probes
const markPrOpened = (s) => {
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
}
// a per-bead wall-clock delay — the fairness test's long worker: the
// detached spawn means the loop must service other members while this
// one sleeps (bro-zpa93)
const delayMs = Number((load().delays ?? {})[process.env.BRO_BEAD_ID] ?? 0)
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
if (prompt.includes('review-threads')) {
  // fix round — resolve the threads and stop
  withState((s) => { s.threads = [] })
  log('resolved threads')
  process.exit(0)
}
if (prompt.includes('merge conflicts')) {
  // rebase round — clear the conflict and stop
  withState((s) => {
    s.mergeable = 'MERGEABLE'
    if (s.prs?.[branch]) s.prs[branch].mergeable = 'MERGEABLE'
    s.events = (s.events ?? []).concat([{ rebase: process.env.BRO_BEAD_ID || null, branch }])
  })
  log('rebased onto base')
  process.exit(0)
}
if (prompt.includes('CI fixer')) {
  // ci-fail round — clear the failing checks and stop. fixerNoop leaves
  // them red: the drive dedup test needs an ok-exit with nothing fixed.
  const cleared = withState((s) => {
    if (s.fixerNoop === true) return false
    s.checks = []
    if (s.prs?.[branch]) s.prs[branch].checks = []
    return true
  })
  log(cleared ? 'cleared checks' : 'left failing (noop)')
  process.exit(0)
}
if (prompt.includes('SAST fixer')) {
  // sast round — clear the annotation counts and stop
  const cleared = withState((s) => {
    if (s.fixerNoop === true) return false
    s.annotations = {}
    return true
  })
  log(cleared ? 'cleared annotations' : 'left findings (noop)')
  process.exit(0)
}
switch (scenario) {
  case 'land': {
    retry(() => fs.writeFileSync('work.txt', 'did the thing\\n'))
    sh('git', ['add', '-A'])
    sh('git', ['commit', '-qm', 'feat: the thing'])
    withState((s) => {
      s.events = (s.events ?? []).concat([{ spawn: process.env.BRO_BEAD_ID || null, branch }])
      markPrOpened(s)
    })
    log('opened pr')
    peekLoop('worker-done')
    break
  }
  case 'batch': case 'batch-partial': {
    // one worker carrying the whole clump — per-bead commits NAMING the
    // id are the coverage contract (bro-nspj7). 'batch-partial' covers
    // only the lead: the tail is the unfinished-requeue case.
    const ids = String(process.env.BRO_BEAD_IDS || process.env.BRO_BEAD_ID || '')
      .split(',')
      .filter(Boolean)
    const cover = scenario === 'batch-partial' ? ids.slice(0, 1) : ids
    for (const id of cover) {
      retry(() => fs.writeFileSync('work-' + id + '.txt', 'did ' + id + '\\n'))
      sh('git', ['add', '-A'])
      sh('git', ['commit', '-qm', 'fix: ' + id + ' work (' + id + ')'])
    }
    withState((s) => {
      s.events = (s.events ?? []).concat([
        { spawn: process.env.BRO_BEAD_ID || null, ids: ids.join(','), branch },
      ])
      markPrOpened(s)
    })
    log('opened pr for ' + ids.join(','))
    peekLoop('worker-done')
    break
  }
  case 'verdict':
    sh('bd', ['close', process.env.BRO_BEAD_ID, '--reason', 'nothing to ship'])
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
  return readJsonRetry(state) as Record<string, unknown>
}

export interface HostFixture {
  root: string
  main: string
  db: string
  hostState: string
  run: (args: string[]) => CliResult
}

/** Repo + fake bd + fake review host + connector wiring in one — the
 *  shared scaffold every review-host e2e (drive/act merges) builds on.
 *  `loopAgent` wires `loop.agent` to the fake agent — the fixer spawn's
 *  command fallback (agents.native.command unset). */
export function hostFixture(prefix: string, opts: { loopAgent?: boolean } = {}): HostFixture {
  const { root, main } = initRepo(prefix)
  const { binDir, db } = installFakeBd(root)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      ...(opts.loopAgent === true ? { loop: { agent: `node ${host.agent}` } } : {}),
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    run: (args) => runCli(args, { cwd: main, env }),
  }
}

/** Repo + fake bd + a PATH-pinned spawn env — the minimal scaffold for
 *  spawned-CLI e2e that doesn't need the fake review host. `rows` seeds
 *  the store at install (see installFakeBd). */
export function e2eRepo(
  prefix: string,
  rows: Array<Record<string, unknown>> = []
): { main: string; db: string; env: Record<string, string> } {
  const { root, main } = initRepo(prefix)
  const { binDir, db } = installFakeBd(root, rows)
  return {
    main,
    db,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db },
  }
}

/** A `tasks` connector over tasks.json beside the plugin — the
 *  configured-backend fixture half: `connectors.tasks` pins it and the
 *  facade's TaskStore ops land on this file instead of `bd`. Only the
 *  surface the bead-close path needs is implemented. */
const FAKE_TASKS_PLUGIN = `// e2e fixture — a tasks connector driven by tasks.json beside this file
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const DB = join(dirname(fileURLToPath(import.meta.url)), 'tasks.json')
// same CI-jitter shield as the host fakes — a transient fs throw
// inside tasks.close lands in the merge path's catch (bro-6u1tu)
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const retry = (fn) => {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i > 40) throw e
      pause(25)
    }
  }
}
const load = () => retry(() => JSON.parse(readFileSync(DB, 'utf8')))
const save = (db) => {
  const tmp = DB + '.tmp.' + process.pid
  retry(() => {
    writeFileSync(tmp, JSON.stringify(db))
    renameSync(tmp, DB)
  })
}
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
  // the same mkdir lock + tmp+rename the embedded fixtures serialize on
  // — a mid-run scripted write must not lose to a worker's mutation
  const lock = `${state}.lock`
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (i > 2000) throw new Error('host state lock wedged')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    const cur = existsSync(state) ? (readJsonRetry(state) as Record<string, unknown>) : {}
    const tmp = `${state}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ ...cur, ...patch }))
    renameSync(tmp, state)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// --- drive e2e scaffolding ------------------------------------------------
// The `bro drive` suites share the repo + fake bd + fake host wiring and
// the verdict/spawn assertions — declared once here, per the fixture-clone
// rule at the top of this file.

export interface DriveFixture {
  root: string
  main: string
  db: string
  hostState: string
  run: (args: string[]) => CliResult
}

/** Repo + fake bd + fake host + bro.config wiring — `loop.agent` is the
 *  fixer spawn's command fallback (agents.native.command unset). */
export function driveFixture(prefix: string): DriveFixture {
  const { root, main } = initRepo(prefix)
  const { binDir, db } = installFakeBd(root)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      loop: { agent: `node ${host.agent}` },
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    run: (args) => runCli(['drive', ...args], { cwd: main, env }),
  }
}

/** The one `{"verdict": …}` row on `drive --json` stdout. */
export function driveVerdict(r: CliResult): { verdict?: string; detail?: string } {
  return (JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"verdict"')) ?? '{}') ??
    {}) as { verdict?: string; detail?: string }
}

export async function waitFor(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) {
      return true
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/** Bead rows labelled 'fixer' — the drive sweep's work-order ledger. */
export function fixerRows(db: string): Array<Record<string, unknown>> {
  return readBeads(db).filter((r) => ((r.labels as string[] | undefined) ?? []).includes('fixer'))
}

/** A spawned fixer is detached — completion is its .exit record on the
 *  registry, never a process wait. */
export function exitRecorded(main: string): boolean {
  const agentsDir = join(main, '.git', 'bro', 'agents')
  return existsSync(agentsDir) && readdirSync(agentsDir).some((n) => n.endsWith('.exit'))
}

export function spawnLog(main: string): string {
  const log = join(main, 'spawns.log')
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

/** A live session marker naming the branch — the occupancy guard's
 *  signal that a worker already owns it. */
export function occupyBranch(main: string, branch: string): void {
  const hooks = join(main, '.git', 'bro', 'hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 's1.work'), `${Date.now()}\n${branch}\n`)
}

/** The verdict line plus the no-spawn ledger every declined/capped
 *  drive pass owes: no fixer bead, no spawn-log entry. */
export function assertNoSpawn(f: DriveFixture, r: CliResult, want: string): void {
  const v = driveVerdict(r)
  assert.equal(v.verdict, want, v.detail)
  assert.equal(fixerRows(f.db).length, 0)
  assert.equal(spawnLog(f.main), '')
}

/** The post-fixer pass: gate green → the orphan merged and its fixer
 *  bead closed 'merged via …'. */
export function assertOrphanMerged(f: DriveFixture, r: CliResult, fixerId: unknown): void {
  const v = driveVerdict(r)
  assert.equal(v.verdict, 'merged', v.detail)
  assert.equal(bead(f.db, String(fixerId))?.status, 'closed')
  assert.match(String(bead(f.db, String(fixerId))?.close_reason), /merged via/)
}

// --- shared in-process test helpers --------------------------------------
// Command tests that drive a runXCommand() in-process need the same
// console/exit capture and ambient-env scrub — declare them ONCE here;
// testrepo's own header rule applies (clones count as duplication).

/** process.exit interceptor — die()/usage() becomes a value, not a kill. */
export class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

/** Capture console + intercept process.exit — die()/usage() exit 1/2. */
export async function capture(
  fn: () => Promise<unknown>
): Promise<{ code: number; out: string[]; err: string[] }> {
  const origExit = process.exit
  const origLog = console.log
  const origErr = console.error
  const out: string[] = []
  const err: string[] = []
  console.log = (...a: unknown[]) => out.push(a.join(' '))
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit
  try {
    await fn()
    return { code: 0, out, err }
  } catch (e) {
    if (e instanceof Exit) {
      return { code: e.code, out, err }
    }
    throw e
  } finally {
    process.exit = origExit
    console.log = origLog
    console.error = origErr
  }
}

/** Delete ambient repo/agent pins from process.env (git-location and
 *  GIT_CONFIG* vars, BEADS_DIR, BRO_*, plus caller-named extras) and
 *  return a restore(). An in-process command test run inside a real work
 *  item inherits pins that redirect the fixture's git/beads lookups into
 *  the OUTER repo — same reason testrepo's git() strips them from the
 *  child's env. The same null-config pins are set so git children the
 *  in-process code spawns can't read host hooks/config either. */
export function scrubEnv(extra: string[] = []): () => void {
  const ambient = /^(BEADS_DIR|BRO_)/
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) {
    if (AMBIENT_GIT.test(k) || ambient.test(k) || extra.includes(k)) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }
  // a var that matched AMBIENT_GIT is only in saved when it was set —
  // record the pins too or they'd leak past the restore
  for (const k of ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL']) {
    if (!(k in saved)) saved[k] = process.env[k]
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = devNull
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}
