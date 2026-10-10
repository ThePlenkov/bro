// beads-dolt-server.ts — move a .beads store onto a managed `dolt
// sql-server` endpoint (spec: specs/bro-n59xn.md).
//
// Embedded-mode bd pays engine open + a store flock on every call —
// under loop+drive+watch concurrency the orchestrator's own read planes
// serialize behind that lock and calls ETIMEDOUT. In server mode bd
// hits a socket instead: `dolt.auto-start: false` keeps lifecycle
// external (bd fails fast when the endpoint is down rather than
// spawning an unsupervised twin) and a systemd --user unit keeps the
// server persistent. `bd dolt start` stays the manual cold-start
// fallback — it binds the same pinned port and config file.
//
//   node scripts/beads-dolt-server.ts install [--beads <dir>] [--port <n>]
//   node scripts/beads-dolt-server.ts status  [--beads <dir>]
//   node scripts/beads-dolt-server.ts uninstall [--beads <dir>]
//
// `--beads` resolution: flag → $BEADS_DIR → walk-up for a `.beads` dir →
// sibling of the common git dir (linked-worktree safe). Port defaults
// to the store's port-file value, else the first free port from 37934.
// Everything is idempotent: re-running install converges the same state.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: { beads: { type: 'string' }, port: { type: 'string' }, unit: { type: 'string' } },
  allowPositionals: true,
})
const command = positionals[0]
if (!['install', 'status', 'uninstall'].includes(command ?? '')) {
  console.error('usage: node scripts/beads-dolt-server.ts <install|status|uninstall> [--beads <dir>] [--port <n>] [--unit <name>]')
  process.exit(1)
}

const fail = (msg: string): never => {
  console.error(`beads-dolt-server: ${msg}`) // NOSONAR — error text is the tool's output; paths, not secrets
  process.exit(1)
}

/** Candidate store dir from flag/env/cwd-walk/git — pre-validation. */
function discoverBeads(): string | undefined {
  if (values.beads) return values.beads
  if (process.env.BEADS_DIR) return process.env.BEADS_DIR
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, '.beads', 'metadata.json'))) return join(dir, '.beads')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 30_000 }) // NOSONAR — literal argv, PATH-resolved binary (same contract as gh)
  if (git.status !== 0) return undefined
  const probe = join(dirname(git.stdout.trim()), '.beads')
  return existsSync(join(probe, 'metadata.json')) ? probe : undefined
}

/** CLI-supplied dir → canonical beads store. The argv path is the
 *  contract (installers take the target dir); it is canonicalized,
 *  confined to the user's own tree, required to be printable, and must
 *  hold a metadata.json. */
function resolveBeads(): string {
  const candidate = discoverBeads() ?? fail('no .beads store found — pass --beads <dir>')
  let real: string
  try {
    real = realpathSync(resolve(candidate))
  } catch {
    return fail(`--beads path does not exist: ${candidate}`)
  }
  if (!real.startsWith(homedir() + sep)) {
    fail(`--beads must resolve under $HOME (${homedir()}) — got ${real}`)
  }
  if (/[^\x20-\x7e]/.test(real)) {
    fail(`--beads path contains non-printable characters — refusing`)
  }
  if (!existsSync(join(real, 'metadata.json'))) {
    fail(`${real} has no metadata.json — not a beads store`)
  }
  return real
}

const beads = resolveBeads()
const metaPath = join(beads, 'metadata.json')
const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown> // NOSONAR — validated by resolveBeads

// fs ops on beads-derived paths — the path is canonicalized,
// $HOME-confined, and metadata.json-validated in resolveBeads(); the
// sinks below are the whole point of the tool.
const beadPath = (...p: string[]) => join(beads, ...p)
const rd = (p: string) => readFileSync(beadPath(p), 'utf8') // NOSONAR — canonicalized at resolveBeads
const wr = (p: string, c: string) => writeFileSync(beadPath(p), c) // NOSONAR — canonicalized at resolveBeads
const ex = (p: string) => existsSync(beadPath(p)) // NOSONAR — canonicalized at resolveBeads
const mv = (a: string, b: string) => renameSync(beadPath(a), beadPath(b)) // NOSONAR — canonicalized at resolveBeads
const ls = (p: string) => readdirSync(beadPath(p)) // NOSONAR — canonicalized at resolveBeads
const rm = (p: string) => rmSync(beadPath(p), { recursive: true }) // NOSONAR — canonicalized at resolveBeads
const mk = (p: string) => mkdirSync(beadPath(p), { recursive: true }) // NOSONAR — canonicalized at resolveBeads

const portFileValue = (): number | undefined => {
  if (!ex('dolt-server.port')) return undefined
  const p = Number(rd('dolt-server.port').trim())
  return Number.isInteger(p) && p > 0 ? p : undefined
}

const tcpOpen = (p: number): Promise<boolean> =>
  new Promise((res) => {
    const s = connect({ host: '127.0.0.1', port: p })
    s.once('connect', () => { s.destroy(); res(true) })
    s.once('error', () => res(false))
    s.setTimeout(1500, () => { s.destroy(); res(false) })
  })

/** flag > port file > first free port from 37934 — so a second store on
 *  the same machine never silently collides on the default. */
async function resolvePort(): Promise<number> {
  if (values.port) {
    const p = Number(values.port)
    if (!Number.isInteger(p) || p <= 0 || p > 65535) fail(`bad --port ${values.port} — expected 1-65535`)
    return p
  }
  const configured = portFileValue()
  if (configured) return configured
  for (let p = 37934; p < 38034; p++) {
    if (!(await tcpOpen(p))) return p
  }
  return fail('no free port in 37934-38033 — pass --port')
}
const port = await resolvePort()

if (values.unit && !/^[\w@.-]+\.service$/.test(values.unit)) {
  fail(`bad unit name ${values.unit} — expected <name>.service`)
}
const repoName = basename(dirname(beads)).replace(/[^\w.-]/g, '_')
// hash-suffix keeps two stores whose parent dirs share a basename from
// overwriting each other's unit — the name keys to the store, not the repo
const storeHash = createHash('sha256').update(beads).digest('hex').slice(0, 6)
const unitName = values.unit ?? `beads-dolt-${repoName}-${storeHash}.service`
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
const unitPath = join(unitDir, unitName)

const BLOCK_BEGIN = '# >>> beads-dolt-server (managed) >>>'
const BLOCK_END = '# <<< beads-dolt-server <<<'

const serverConfig = (): string =>
  `log_level: warning
behavior:
    auto_gc_behavior:
        archive_level: 0
listener:
    host: 127.0.0.1
    port: ${port}
cfg_dir: ${beads}/dolt/.doltcfg
user_session_vars: []
jwks: []
`

const configBlock = (): string =>
  `${BLOCK_BEGIN}
dolt:
    auto-start: false
    mode: server
    host: 127.0.0.1
    port: ${port}
gc.endpoint_origin: managed_systemd
gc.endpoint_status: verified
${BLOCK_END}
`

// `%` is a specifier prefix in systemd unit values — escape it
const escUnit = (s: string): string => s.replace(/%/g, '%%')

const unitConfig = (doltBin: string): string =>
  `[Unit]
Description=beads dolt sql-server — ${escUnit(dirname(beads))}
Documentation=https://github.com/steveyegge/beads

[Service]
Type=simple
WorkingDirectory=${escUnit(beadPath('dolt'))}
ExecStart=${doltBin} sql-server --config ${escUnit(beadPath('dolt-server-config.yaml'))}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`

/** Replace (or append) the marked block in config.yaml — flat dotted
 *  `dolt.*` keys are the Viper-read form, but the suppressing read at
 *  store open goes through the nested `dolt:` map, so we write nested. */
function writeConfigBlock(block: string | null): void {
  let text = ex('config.yaml') ? rd('config.yaml') : ''
  const begin = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (begin !== -1 && end !== -1) {
    text = (text.slice(0, begin) + text.slice(end + BLOCK_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  }
  if (block !== null) text = text.trimEnd() + '\n\n' + block
  wr('config.yaml', text)
}

const systemctl = (args: string[]) =>
  spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30_000 }) // NOSONAR — literal argv, unit names regex-validated

/** Absolute path for a PATH-resolved binary — the unit's ExecStart
 *  needs it (systemd PATH is minimal). */
function whereis(bin: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p // NOSONAR — PATH lookup is the contract (same as bd/gh resolution)
    } catch {
      // not here — next dir
    }
  }
  return bin
}

/** `.beads/embeddeddolt` → `.beads/dolt`. Refuses same-name collisions —
 *  a db dir present in both means diverged state a rename would hide. */
function moveDataDir(): void {
  if (!ex('embeddeddolt')) {
    mk('dolt')
    return
  }
  if (!ex('dolt')) {
    mv('embeddeddolt', 'dolt')
    console.log(`moved embeddeddolt → dolt`)
    return
  }
  for (const entry of ls('embeddeddolt')) {
    if (ex(join('dolt', entry))) {
      fail(`collision: ${entry} exists in both embeddeddolt/ and dolt/ — resolve by hand, not by overwrite`)
    }
  }
  for (const entry of ls('embeddeddolt')) {
    mv(join('embeddeddolt', entry), join('dolt', entry))
  }
  rm('embeddeddolt')
  console.log(`merged embeddeddolt/* into dolt/`)
}

function writeEndpointFiles(): void {
  wr('dolt-server-config.yaml', serverConfig())
  wr('dolt-server.port', `${port}\n`)
  meta.dolt_mode = 'server'
  meta.dolt_server_host = '127.0.0.1'
  delete meta.dolt_server_port // deprecated — the port file is primary
  wr('metadata.json', JSON.stringify(meta, null, 2) + '\n')
  writeConfigBlock(configBlock())
}

async function installUnit(): Promise<void> {
  const probe = systemctl(['list-units', '--no-pager'])
  if (probe.status !== 0) {
    console.log(`systemctl --user unavailable — no unit installed`)
    console.log(`manual endpoint: cd ${beads}/dolt && ${whereis('dolt')} sql-server --config ${beads}/dolt-server-config.yaml`) // NOSONAR — recovery instructions are the output's purpose
    return
  }
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(unitPath, unitConfig(whereis('dolt'))) // NOSONAR — unitPath = XDG/.config dir + regex-safe unitName
  for (const step of [['daemon-reload'], ['enable', '--now', unitName]] as const) {
    const r = systemctl([...step])
    if (r.status !== 0) fail(`systemctl --user ${step.join(' ')}: ${r.stderr?.trim() || r.error}`)
  }
  console.log(`systemd --user: ${unitName} enabled + started`) // NOSONAR — progress output; names, not secrets
  // `enable --now` returns before the listener binds — wait for it
  const deadline = Date.now() + 15_000
  let up = false
  while (Date.now() < deadline && !(up = await tcpOpen(port))) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!up) fail(`unit started but 127.0.0.1:${port} never bound — see journalctl --user -u ${unitName}`)
}

async function install(): Promise<void> {
  moveDataDir()
  writeEndpointFiles()
  await installUnit()
  const test = spawnSync('bd', ['dolt', 'test'], { encoding: 'utf8', timeout: 30_000 }) // NOSONAR — literal argv, BEADS_DIR pinned below
  const ok = test.status === 0
  const detail = ok ? (test.stdout.match(/✓.*/)?.[0] ?? 'ok') : `FAILED — ${test.stderr?.trim() || test.stdout?.trim()}`
  console.log(`bd dolt test: ${detail}`)
  console.log(`done. endpoint 127.0.0.1:${port} — cold start: systemctl --user start ${unitName} (or \`bd dolt start\`)`) // NOSONAR — ditto
  if (!ok) process.exit(1)
}

async function status(): Promise<void> {
  const active = systemctl(['is-active', unitName]).stdout.trim() || 'n/a'
  const enabled = systemctl(['is-enabled', unitName]).stdout.trim() || 'n/a'
  const reachable = await tcpOpen(port)
  const dataDir = ex('dolt') ? 'dolt/' : ex('embeddeddolt') ? 'embeddeddolt/ (embedded)' : 'none'
  console.log(`beads:   ${beads}`) // NOSONAR — status output is the tool's purpose; paths, not secrets
  console.log(`mode:    ${String(meta.dolt_mode ?? 'unknown')} (db ${String(meta.dolt_database ?? '?')})`) // NOSONAR — ditto
  console.log(`port:    ${port} (${reachable ? 'reachable' : 'UNREACHABLE'})`) // NOSONAR — ditto
  console.log(`unit:    ${unitName} — ${active}, ${enabled}`) // NOSONAR — ditto
  console.log(`data:    ${dataDir}`) // NOSONAR — ditto
  if (meta.dolt_mode === 'server' && !reachable) {
    console.log(`cold start: systemctl --user start ${unitName} || bd dolt start`) // NOSONAR — ditto
    process.exit(1)
  }
}

function uninstall(): void {
  systemctl(['disable', '--now', unitName])
  rmSync(unitPath, { force: true }) // NOSONAR — unitPath = XDG/.config dir + regex-safe unitName
  systemctl(['daemon-reload'])
  writeConfigBlock(null)
  console.log(`removed ${unitName} + endpoint config block.`) // NOSONAR — ditto
  console.log(`store stays server-mode: run \`bd dolt start\` for an on-demand server, or re-run install.`)
}

process.env.BEADS_DIR = beads // pin every bd call to the store we're managing
if (command === 'install') await install()
else if (command === 'status') await status()
else uninstall()
