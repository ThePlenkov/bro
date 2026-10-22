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

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

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

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

type ParsedLedgerRow = Record<string, unknown> & LedgerRow

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value)
}

type FieldCheck = readonly [field: string, validate: (value: unknown) => boolean]

function matchesFields(value: Record<string, unknown>, checks: readonly FieldCheck[]): boolean {
  return checks.every(([field, validate]) => validate(value[field]))
}

const ledgerRowChecks: readonly FieldCheck[] = [
  ['cause', isWallCause],
  ['observedAt', isTimestamp],
  ['provider', isString],
  ['rig', isString],
  ['resetAt', isOptionalTimestamp],
  ['step', isOptionalString],
]

const observationChecks: readonly FieldCheck[] = [
  ['account', isString],
  ['cause', isWallCause],
  ['observedAt', isTimestamp],
  ['provider', isString],
  ['rig', isString],
  ['resetAt', isOptionalTimestamp],
  ['step', isOptionalString],
]

function isLedgerRow(value: unknown): value is ParsedLedgerRow {
  return isObject(value) && matchesFields(value, ledgerRowChecks)
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
  if (!isLedgerRow(value)) {
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

function readLedgerText(path: string): string | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is local operator state
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnUnreadable()
    }
    return undefined
  }
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseLedger(json: unknown): LedgerState | undefined {
  if (!isObject(json)) {
    return undefined
  }
  if (json.version !== 1) {
    return undefined
  }
  if (!isObject(json.walls)) {
    return undefined
  }
  const state = emptyState()
  for (const [account, raw] of Object.entries(json.walls)) {
    const row = parseRow(raw)
    if (row === undefined) {
      return undefined
    }
    setLedgerRow(state, account, row)
  }
  return state
}

function readState(path: string): LedgerState {
  const text = readLedgerText(path)
  if (text === undefined) {
    return emptyState()
  }
  const json = parseJson(text)
  if (json === undefined) {
    warnUnreadable()
    return emptyState()
  }
  const state = parseLedger(json)
  if (state === undefined) {
    warnUnreadable()
    return emptyState()
  }
  warnedUnreadable = false
  return state
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
    warnedUnreadable = false
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
  return isObject(obs) && matchesFields(obs, observationChecks)
}

function shouldReplace(
  current: LedgerRow | undefined,
  obs: WallObservation,
  now: number,
  ttls: FleetWallTtls
): boolean {
  if (current === undefined) {
    return true
  }
  if (expiryMs(current, ttls) <= now) {
    return true
  }
  if (current.cause === 'quota' && obs.cause === 'rate_limited') {
    return false
  }
  return Date.parse(obs.observedAt) >= Date.parse(current.observedAt)
}

export function recordWall(obs: WallObservation, opts: WallLedgerOptions = {}): void {
  if (!validObservation(obs)) {
    throw new TypeError('invalid host wall observation')
  }
  const now = opts.now ?? Date.now()
  const ttls = ttlsOf(opts.ttls)
  const ledgerPath = opts.path ?? wallLedgerPath()
  updateLedger(ledgerPath, (state) => {
    pruneExpired(state, now, ttls)
    const current = state.walls[obs.account]
    if (shouldReplace(current, obs, now, ttls)) {
      const { account: _account, ...row } = obs
      setLedgerRow(state, obs.account, row)
    }
    pruneExpired(state, now, ttls)
    writeState(ledgerPath, state)
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
    const removed =
      account === 'all'
        ? Object.keys(state.walls).length
        : Object.hasOwn(state.walls, account)
          ? 1
          : 0
    if (account === 'all') {
      state.walls = Object.create(null) as Partial<Record<string, LedgerRow>>
    } else {
      removeLedgerRow(state, account)
    }
    pruneExpired(state, now, ttls)
    writeState(path, state)
    return removed
  })
}
