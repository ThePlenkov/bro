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
// to 37934 or the store's port-file value. Everything is idempotent:
// re-running install converges the same state.

import { spawnSync } from 'node:child_process'
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
  console.error(`beads-dolt-server: ${msg}`)
  process.exit(1)
}

/** Literal-argv spawn — no shell strings, ever. */
const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 })

/** CLI-supplied dir → canonical beads store. The argv path is the
 *  contract (installers take the target dir); it is confined to the
 *  user's own tree and must hold a metadata.json. */
function resolveBeads(): string {
  let candidate: string | undefined
  if (values.beads) {
    candidate = values.beads
  } else if (process.env.BEADS_DIR) {
    candidate = process.env.BEADS_DIR
  } else {
    let dir = process.cwd()
    for (;;) {
      if (existsSync(join(dir, '.beads', 'metadata.json'))) {
        candidate = join(dir, '.beads')
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (!candidate) {
      const git = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (git.status === 0) {
        const probe = join(dirname(git.stdout.trim()), '.beads')
        if (existsSync(join(probe, 'metadata.json'))) candidate = probe
      }
    }
  }
  if (!candidate) fail('no .beads store found — pass --beads <dir>')
  let real: string
  try {
    real = realpathSync(resolve(candidate))
  } catch {
    return fail(`--beads path does not exist: ${candidate}`)
  }
  if (!real.startsWith(homedir() + sep)) {
    fail(`--beads must resolve under $HOME (${homedir()}) — got ${real}`)
  }
  if (!existsSync(join(real, 'metadata.json'))) {
    fail(`${real} has no metadata.json — not a beads store`)
  }
  return real
}

const beads = resolveBeads() // NOSONAR — canonicalized + validated above; every fs sink below derives from it
const metaPath = join(beads, 'metadata.json')
const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>

const portFile = join(beads, 'dolt-server.port')
const portFileValue = (): number | undefined => {
  if (existsSync(portFile)) {
    const p = Number(readFileSync(portFile, 'utf8').trim())
    if (Number.isInteger(p) && p > 0) return p
  }
  return undefined
}
const port = values.port ? Number(values.port) : (portFileValue() ?? 37934)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`bad port ${values.port ?? '(port file)'} — expected 1-65535`)
}
if (values.unit && !/^[\w@.-]+\.service$/.test(values.unit)) {
  fail(`bad unit name ${values.unit} — expected <name>.service`)
}

const repoName = basename(dirname(beads))
const unitName = values.unit ?? `beads-dolt-${repoName}.service`
const unitDir = join(homedir(), '.config', 'systemd', 'user')
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

const unitConfig = (doltBin: string): string =>
  `[Unit]
Description=beads dolt sql-server — ${dirname(beads)}
Documentation=https://github.com/steveyegge/beads

[Service]
Type=simple
WorkingDirectory=${beads}/dolt
ExecStart=${doltBin} sql-server --config ${beads}/dolt-server-config.yaml
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`

/** Replace (or append) the marked block in config.yaml — flat dotted
 *  `dolt.*` keys are the Viper-read form, but the suppressing read at
 *  store open goes through the nested `dolt:` map, so we write nested. */
function writeConfigBlock(block: string | null): void {
  const cfgPath = join(beads, 'config.yaml')
  let text = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
  const begin = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (begin !== -1 && end !== -1) {
    text = (text.slice(0, begin) + text.slice(end + BLOCK_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  }
  if (block !== null) text = text.trimEnd() + '\n\n' + block
  writeFileSync(cfgPath, text)
}

const tcpOpen = (p: number): Promise<boolean> =>
  new Promise((res) => {
    const s = connect({ host: '127.0.0.1', port: p })
    s.once('connect', () => { s.destroy(); res(true) })
    s.once('error', () => res(false))
    s.setTimeout(1500, () => { s.destroy(); res(false) })
  })

const systemctl = (args: string[]) => run('systemctl', ['--user', ...args])

/** Absolute path for a PATH-resolved binary — the unit's ExecStart
 *  needs it (systemd PATH is minimal). PATH itself is the contract —
 *  same lookup any shell does. */
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
  const embedded = join(beads, 'embeddeddolt')
  const doltDir = join(beads, 'dolt')
  if (!existsSync(embedded)) {
    mkdirSync(doltDir, { recursive: true })
    return
  }
  if (!existsSync(doltDir)) {
    renameSync(embedded, doltDir)
    console.log(`moved ${embedded} → ${doltDir}`)
    return
  }
  for (const entry of readdirSync(embedded)) {
    if (existsSync(join(doltDir, entry))) {
      fail(`collision: ${entry} exists in both embeddeddolt/ and dolt/ — resolve by hand, not by overwrite`)
    }
  }
  for (const entry of readdirSync(embedded)) {
    renameSync(join(embedded, entry), join(doltDir, entry))
  }
  rmSync(embedded, { recursive: true })
  console.log(`merged ${embedded}/* into ${doltDir}`)
}

function writeEndpointFiles(): void {
  writeFileSync(join(beads, 'dolt-server-config.yaml'), serverConfig())
  writeFileSync(portFile, `${port}\n`)
  meta.dolt_mode = 'server'
  meta.dolt_server_host = '127.0.0.1'
  delete meta.dolt_server_port // deprecated — the port file is primary
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
  writeConfigBlock(configBlock())
}

async function installUnit(): Promise<void> {
  if (!existsSync(unitDir)) {
    console.log(`no ${unitDir} — skipping systemd unit (no user manager?)`)
    console.log(`manual endpoint: cd ${beads}/dolt && ${whereis('dolt')} sql-server --config ${beads}/dolt-server-config.yaml`)
    return
  }
  writeFileSync(unitPath, unitConfig(whereis('dolt')))
  for (const step of [['daemon-reload'], ['enable', '--now', unitName]] as const) {
    const r = systemctl([...step])
    if (r.status !== 0) fail(`systemctl --user ${step.join(' ')}: ${r.stderr?.trim() || r.error}`)
  }
  console.log(`systemd --user: ${unitName} enabled + started`)
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
  const test = run('bd', ['dolt', 'test'])
  const ok = test.status === 0
  const detail = ok ? (test.stdout.match(/✓.*/)?.[0] ?? 'ok') : `FAILED — ${test.stderr?.trim() || test.stdout?.trim()}`
  console.log(`bd dolt test: ${detail}`)
  console.log(`done. endpoint 127.0.0.1:${port} — cold start: systemctl --user start ${unitName} (or \`bd dolt start\`)`)
  if (!ok) process.exit(1)
}

async function status(): Promise<void> {
  const active = systemctl(['is-active', unitName]).stdout.trim() || 'n/a'
  const enabled = systemctl(['is-enabled', unitName]).stdout.trim() || 'n/a'
  const reachable = await tcpOpen(port)
  const dataDir = existsSync(join(beads, 'dolt')) ? 'dolt/' : existsSync(join(beads, 'embeddeddolt')) ? 'embeddeddolt/ (embedded)' : 'none'
  console.log(`beads:   ${beads}`)
  console.log(`mode:    ${String(meta.dolt_mode ?? 'unknown')} (db ${String(meta.dolt_database ?? '?')})`)
  console.log(`port:    ${port} (${reachable ? 'reachable' : 'UNREACHABLE'})`)
  console.log(`unit:    ${unitName} — ${active}, ${enabled}`)
  console.log(`data:    ${dataDir}`)
  if (meta.dolt_mode === 'server' && !reachable) {
    console.log(`cold start: systemctl --user start ${unitName} || bd dolt start`)
    process.exit(1)
  }
}

function uninstall(): void {
  systemctl(['disable', '--now', unitName])
  rmSync(unitPath, { force: true })
  systemctl(['daemon-reload'])
  writeConfigBlock(null)
  console.log(`removed ${unitName} + endpoint config block.`)
  console.log(`store stays server-mode: run \`bd dolt start\` for an on-demand server, or re-run install.`)
}

process.env.BEADS_DIR = beads // pin every bd call to the store we're managing
if (command === 'install') await install()
else if (command === 'status') await status()
else uninstall()
