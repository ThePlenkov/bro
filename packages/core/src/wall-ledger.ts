import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from './filelock.ts'
import {
  DEFAULT_FLEET_WALL_TTLS,
  type AccountWall,
  type FleetWallTtls,
} from './routing.ts'

export interface WallObservation {
  account: string
  cause: 'rate_limited' | 'quota'
  resetAt?: string
  observedAt: string
  provider: string
  rig: string
  step?: string
}

export interface WallLedgerOptions {
  path?: string
  now?: number
  ttls?: Partial<FleetWallTtls>
}

interface LedgerRow extends Omit<WallObservation, 'account'> {}
interface LedgerState {
  version: 1
  walls: Record<string, LedgerRow>
}

let warnedUnreadable = false

export function wallLedgerPath(stateHome = process.env.XDG_STATE_HOME): string {
  return join(stateHome || join(homedir(), '.local', 'state'), 'bro', 'walls.json')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function emptyState(): LedgerState {
  return { version: 1, walls: Object.create(null) as Record<string, LedgerRow> }
}

function warnUnreadable(): void {
  if (!warnedUnreadable) {
    warnedUnreadable = true
    console.error('bro: host wall ledger is unreadable or corrupt — treating it as empty')
  }
}

function parseRow(value: unknown): LedgerRow | undefined {
  if (
    !isObject(value) ||
    (value.cause !== 'rate_limited' && value.cause !== 'quota') ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.provider !== 'string' ||
    typeof value.rig !== 'string' ||
    (value.resetAt !== undefined &&
      (typeof value.resetAt !== 'string' || !Number.isFinite(Date.parse(value.resetAt)))) ||
    (value.step !== undefined && typeof value.step !== 'string')
  ) {
    return undefined
  }
  return {
    cause: value.cause,
    ...(typeof value.resetAt === 'string' ? { resetAt: value.resetAt } : {}),
    observedAt: value.observedAt,
    provider: value.provider,
    rig: value.rig,
    ...(typeof value.step === 'string' ? { step: value.step } : {}),
  }
}

function readState(path: string): LedgerState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnUnreadable()
    }
    return emptyState()
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.walls)) {
      throw new SyntaxError('invalid wall ledger shape')
    }
    const state = emptyState()
    for (const [account, raw] of Object.entries(parsed.walls)) {
      const row = parseRow(raw)
      if (row === undefined) {
        throw new SyntaxError('invalid wall ledger row')
      }
      state.walls[account] = row
    }
    return state
  } catch {
    warnUnreadable()
    return emptyState()
  }
}

function ttlsOf(ttls?: Partial<FleetWallTtls>): FleetWallTtls {
  return { ...DEFAULT_FLEET_WALL_TTLS, ...ttls }
}

function expiryMs(row: LedgerRow, ttls: FleetWallTtls): number {
  if (row.resetAt !== undefined) {
    return Date.parse(row.resetAt)
  }
  const minutes =
    row.cause === 'rate_limited' ? ttls.rateTtlMinutes : ttls.quotaTtlMinutes
  return Date.parse(row.observedAt) + minutes * 60_000
}

function pruneExpired(state: LedgerState, now: number, ttls: FleetWallTtls): void {
  for (const [account, row] of Object.entries(state.walls)) {
    if (expiryMs(row, ttls) <= now) {
      delete state.walls[account]
    }
  }
}

function prepareDirectory(path: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function writeState(path: string, state: LedgerState): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(state))
    closeSync(fd)
    fd = undefined
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    if (fd !== undefined) {
      closeSync(fd)
    }
    rmSync(tmp, { force: true })
    throw err
  }
}

function updateLedger<T>(
  path: string,
  update: (state: LedgerState) => T
): T {
  prepareDirectory(path)
  return withFileLock(`${path}.lock`, () => update(readState(path)))
}

function validObservation(obs: WallObservation): boolean {
  return (
    typeof obs.account === 'string' &&
    typeof obs.provider === 'string' &&
    typeof obs.rig === 'string' &&
    (obs.cause === 'rate_limited' || obs.cause === 'quota') &&
    typeof obs.observedAt === 'string' &&
    Number.isFinite(Date.parse(obs.observedAt)) &&
    (obs.resetAt === undefined ||
      (typeof obs.resetAt === 'string' && Number.isFinite(Date.parse(obs.resetAt)))) &&
    (obs.step === undefined || typeof obs.step === 'string')
  )
}

export function recordWall(obs: WallObservation, opts: WallLedgerOptions = {}): void {
  if (!validObservation(obs)) {
    throw new TypeError('invalid host wall observation')
  }
  const now = opts.now ?? Date.now()
  const ttls = ttlsOf(opts.ttls)
  updateLedger(opts.path ?? wallLedgerPath(), (state) => {
    pruneExpired(state, now, ttls)
    const current = state.walls[obs.account]
    const currentLive = current !== undefined && expiryMs(current, ttls) > now
    const quotaHolds =
      currentLive && current?.cause === 'quota' && obs.cause === 'rate_limited'
    const newer =
      current === undefined || Date.parse(obs.observedAt) >= Date.parse(current.observedAt)
    if (!quotaHolds && newer) {
      const { account: _account, ...row } = obs
      state.walls[obs.account] = row
    }
    pruneExpired(state, now, ttls)
    writeState(opts.path ?? wallLedgerPath(), state)
  })
}

export function readLedgerWalls(
  now = Date.now(),
  ttls?: Partial<FleetWallTtls>,
  opts: Pick<WallLedgerOptions, 'path'> = {}
): AccountWall[] {
  const effectiveTtls = ttlsOf(ttls)
  const state = readState(opts.path ?? wallLedgerPath())
  return Object.entries(state.walls)
    .flatMap(([account, row]) => {
      const expiry = expiryMs(row, effectiveTtls)
      if (!(expiry > now) || !Number.isFinite(expiry)) {
        return []
      }
      return [{
        account,
        cause: row.cause,
        ...(row.resetAt === undefined ? {} : { resetAt: row.resetAt }),
        until: new Date(expiry).toISOString(),
        observedAt: row.observedAt,
        provider: row.provider,
        rig: row.rig,
        ...(row.step === undefined ? {} : { step: row.step }),
      }]
    })
    .sort((a, b) => a.account.localeCompare(b.account))
}

export function clearLedgerWalls(
  account: string | 'all',
  opts: WallLedgerOptions = {}
): number {
  const path = opts.path ?? wallLedgerPath()
  const now = opts.now ?? Date.now()
  const ttls = ttlsOf(opts.ttls)
  return updateLedger(path, (state) => {
    pruneExpired(state, now, ttls)
    const removed = account === 'all'
      ? Object.keys(state.walls).length
      : Object.hasOwn(state.walls, account) ? 1 : 0
    if (account === 'all') {
      state.walls = Object.create(null) as Record<string, LedgerRow>
    } else {
      delete state.walls[account]
    }
    writeState(path, state)
    return removed
  })
}
