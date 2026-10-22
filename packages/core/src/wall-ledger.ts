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
  walls: Partial<Record<string, LedgerRow>>
}

let warnedUnreadable = false

export function wallLedgerPath(stateHome = process.env.XDG_STATE_HOME): string {
  return join(stateHome || join(homedir(), '.local', 'state'), 'bro', 'walls.json')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function emptyState(): LedgerState {
  return { version: 1, walls: Object.create(null) as Partial<Record<string, LedgerRow>> }
}

function warnUnreadable(): void {
  if (!warnedUnreadable) {
    warnedUnreadable = true
    console.error('bro: host wall ledger is unreadable or corrupt — treating it as empty')
  }
}

function isWallCause(value: unknown): value is WallObservation['cause'] {
  return value === 'rate_limited' || value === 'quota'
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function setLedgerRow(state: LedgerState, account: string, row: LedgerRow): void {
  Object.defineProperty(state.walls, account, {
    configurable: true,
    enumerable: true,
    value: row,
    writable: true,
  })
}

function removeLedgerRow(state: LedgerState, account: string): void {
  Reflect.deleteProperty(state.walls, account)
}

function parseRow(value: unknown): LedgerRow | undefined {
  if (!isObject(value)) {
    return undefined
  }
  if (!isWallCause(value.cause) || !isTimestamp(value.observedAt)) {
    return undefined
  }
  if (typeof value.provider !== 'string' || typeof value.rig !== 'string') {
    return undefined
  }
  if (value.resetAt !== undefined && !isTimestamp(value.resetAt)) {
    return undefined
  }
  if (value.step !== undefined && typeof value.step !== 'string') {
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is local operator state
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
      setLedgerRow(state, account, row)
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
    if (row !== undefined && expiryMs(row, ttls) <= now) {
      removeLedgerRow(state, account)
    }
  }
}

function prepareDirectory(path: string): void {
  const dir = dirname(path)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ledger directory is local operator state
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ledger directory is local operator state
  chmodSync(dir, 0o700)
}

function writeState(path: string, state: LedgerState): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temporary file is beside local ledger state
    fd = openSync(tmp, 'wx', 0o600)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file descriptor belongs to the local ledger temp file
    writeFileSync(fd, JSON.stringify(state))
    closeSync(fd)
    fd = undefined
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temporary file is beside local ledger state
    chmodSync(tmp, 0o600)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are the local ledger and its temporary sibling
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

function validObservation(obs: unknown): obs is WallObservation {
  if (!isObject(obs)) {
    return false
  }
  if (
    typeof obs.account !== 'string' ||
    !isWallCause(obs.cause) ||
    !isTimestamp(obs.observedAt) ||
    typeof obs.provider !== 'string' ||
    typeof obs.rig !== 'string'
  ) {
    return false
  }
  if (obs.resetAt !== undefined && !isTimestamp(obs.resetAt)) {
    return false
  }
  return obs.step === undefined || typeof obs.step === 'string'
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
      setLedgerRow(state, obs.account, row)
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
      if (row === undefined) {
        return []
      }
      const expiry = expiryMs(row, effectiveTtls)
      if (expiry <= now || !Number.isFinite(expiry)) {
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
  account: string,
  opts: WallLedgerOptions = {}
): number {
  const path = opts.path ?? wallLedgerPath()
  const now = opts.now ?? Date.now()
  const ttls = ttlsOf(opts.ttls)
  return updateLedger(path, (state) => {
    pruneExpired(state, now, ttls)
    let removed = 0
    if (account === 'all') {
      removed = Object.keys(state.walls).length
      state.walls = Object.create(null) as Partial<Record<string, LedgerRow>>
    } else {
      if (Object.hasOwn(state.walls, account)) {
        removed = 1
      }
      removeLedgerRow(state, account)
    }
    writeState(path, state)
    return removed
  })
}
