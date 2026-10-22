import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from './filelock.ts'

export interface LeaseHolder {
  host: string
  pid: number
  rig: string
  agentId?: string
  sessionId?: string
}

export interface Lease {
  key: string
  token: string
  holder: LeaseHolder
  acquiredAt: string
  expiresAt: string
}

export type LeaseAcquire =
  | { ok: true; lease: Lease }
  | { ok: false; held: Lease }

export interface LeaseStore {
  acquire(key: string, holder: LeaseHolder, ttlMs: number): LeaseAcquire
  renew(lease: Lease, ttlMs: number): Lease | undefined
  release(lease: Lease): void
  read(key: string): Lease | undefined
  rebind(lease: Lease, holderPatch: Partial<LeaseHolder>): Lease | undefined
  forceRelease(key: string): boolean
  list(): Lease[]
}

export interface LocalLeaseStoreOptions {
  stateHome?: string
  now?: () => number
  host?: string
  pidAlive?: (pid: number) => boolean
}

interface LocalDependencies {
  directory: string
  directories: string[]
  now: () => number
  host: string
  pidAlive: (pid: number) => boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function optionalString(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  return isString(value)
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value))
}

function holderIdentityIsValid(value: Record<string, unknown>): boolean {
  if (!isString(value.host)) {
    return false
  }
  return isString(value.rig)
}

function holderPidIsValid(value: Record<string, unknown>): boolean {
  if (typeof value.pid !== 'number') {
    return false
  }
  if (!Number.isInteger(value.pid)) {
    return false
  }
  return value.pid > 0
}

function holderOptionalIdsAreValid(value: Record<string, unknown>): boolean {
  if (!optionalString(value.agentId)) {
    return false
  }
  return optionalString(value.sessionId)
}

function isHolder(value: unknown): value is LeaseHolder {
  if (!isObject(value)) {
    return false
  }
  if (!holderIdentityIsValid(value)) {
    return false
  }
  if (!holderPidIsValid(value)) {
    return false
  }
  return holderOptionalIdsAreValid(value)
}

function isLease(value: unknown): value is Lease {
  if (!isObject(value)) {
    return false
  }
  if (!isString(value.key) || !isString(value.token)) {
    return false
  }
  if (!isHolder(value.holder)) {
    return false
  }
  return isTimestamp(value.acquiredAt) && isTimestamp(value.expiresAt)
}

function readLease(path: string): Lease | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a project-scoped lease file
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isLease(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function systemPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function makeDependencies(
  project: string,
  options: LocalLeaseStoreOptions
): LocalDependencies {
  const configuredHome = options.stateHome ?? process.env.XDG_STATE_HOME
  const stateHome =
    configuredHome === undefined || configuredHome === ''
      ? join(homedir(), '.local', 'state')
      : configuredHome
  return {
    directory: join(stateHome, 'bro', 'projects', project, 'leases'),
    directories: [
      join(stateHome, 'bro'),
      join(stateHome, 'bro', 'projects'),
      join(stateHome, 'bro', 'projects', project),
      join(stateHome, 'bro', 'projects', project, 'leases'),
    ],
    now: options.now ?? Date.now,
    host: options.host ?? hostname(),
    pidAlive: options.pidAlive ?? systemPidAlive,
  }
}

function leasePath(deps: LocalDependencies, key: string): string {
  return join(deps.directory, `${encodeURIComponent(key)}.json`)
}

function ensureDirectory(path: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory is derived from local XDG state
  mkdirSync(path, { recursive: true, mode: 0o700 })
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory is derived from local XDG state
  chmodSync(path, 0o700)
}

function ensureDirectories(deps: LocalDependencies): void {
  for (const directory of deps.directories) {
    ensureDirectory(directory)
  }
}

function writeLease(path: string, lease: Lease): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temporary file is beside a project-scoped lease
    writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temporary file is beside a project-scoped lease
    chmodSync(temporary, 0o600)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are the lease and its temporary sibling
    renameSync(temporary, path)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a project-scoped lease file
    chmodSync(path, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function live(lease: Lease | undefined, deps: LocalDependencies, now: number): lease is Lease {
  if (lease === undefined || Date.parse(lease.expiresAt) <= now) {
    return false
  }
  if (lease.holder.host !== deps.host) {
    return true
  }
  return deps.pidAlive(lease.holder.pid)
}

function removeLease(path: string): void {
  rmSync(path, { force: true })
}

function tokenMatches(current: Lease | undefined, lease: Lease): current is Lease {
  return current?.token === lease.token
}

export function localLeaseStore(
  project: string,
  options: LocalLeaseStoreOptions = {}
): LeaseStore {
  const deps = makeDependencies(project, options)
  const withKeyLock = <T>(key: string, operation: (path: string) => T): T => {
    ensureDirectories(deps)
    const path = leasePath(deps, key)
    return withFileLock(`${path}.lock`, () => operation(path))
  }

  const store: LeaseStore = {
    acquire(key, holder, ttlMs) {
      return withKeyLock(key, (path) => {
        const now = deps.now()
        const current = readLease(path)
        if (live(current, deps, now)) {
          return { ok: false, held: current }
        }
        const lease: Lease = {
          key,
          token: randomUUID(),
          holder: { ...holder },
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString(),
        }
        writeLease(path, lease)
        return { ok: true, lease }
      })
    },
    renew(lease, ttlMs) {
      return withKeyLock(lease.key, (path) => {
        const now = deps.now()
        const current = readLease(path)
        if (!tokenMatches(current, lease) || !live(current, deps, now)) {
          return undefined
        }
        const renewed = { ...current, expiresAt: new Date(now + ttlMs).toISOString() }
        writeLease(path, renewed)
        return renewed
      })
    },
    release(lease) {
      withKeyLock(lease.key, (path) => {
        if (tokenMatches(readLease(path), lease)) {
          removeLease(path)
        }
      })
    },
    read(key) {
      return withKeyLock(key, (path) => {
        const lease = readLease(path)
        return live(lease, deps, deps.now()) ? lease : undefined
      })
    },
    rebind(lease, holderPatch) {
      return withKeyLock(lease.key, (path) => {
        const now = deps.now()
        const current = readLease(path)
        if (!tokenMatches(current, lease) || !live(current, deps, now)) {
          return undefined
        }
        const rebound: Lease = {
          ...current,
          holder: { ...current.holder, ...holderPatch },
        }
        writeLease(path, rebound)
        return rebound
      })
    },
    forceRelease(key) {
      return withKeyLock(key, (path) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a project-scoped lease file
        const existed = existsSync(path)
        removeLease(path)
        return existed
      })
    },
    list() {
      let names: string[]
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory is derived from local XDG state
        names = readdirSync(deps.directory)
      } catch {
        return []
      }
      const leases: Lease[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue
        }
        const encodedKey = name.slice(0, -'.json'.length)
        const path = join(deps.directory, name)
        const lease = withFileLock(`${path}.lock`, () => readLease(path))
        if (lease === undefined || encodeURIComponent(lease.key) !== encodedKey) {
          continue
        }
        if (live(lease, deps, deps.now())) {
          leases.push(lease)
        }
      }
      return leases
    },
  }
  return store
}

export class RoleLeaseAbortedError extends Error {
  override name = 'RoleLeaseAbortedError'
}

export interface HoldRoleLeaseOptions {
  signal?: AbortSignal
  onLost?: () => void
  onAbort?: () => void
  exit?: (code: number) => void
  log?: (line: string) => void
}

function roleHolderLine(key: string, lease: Lease): string {
  const holder = lease.holder
  return `standby — ${key} held by ${holder.rig}@${holder.host} pid ${holder.pid}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RoleLeaseAbortedError('role lease acquisition aborted'))
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(new RoleLeaseAbortedError('role lease acquisition aborted'))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function waitForRole(
  store: LeaseStore,
  key: string,
  ttlMs: number,
  options: HoldRoleLeaseOptions
): Promise<void> {
  const log = options.log ?? console.error
  const interval = Math.min(5000, ttlMs / 3)
  const poll = (): Promise<void> => {
    const current = store.read(key)
    if (current === undefined) {
      return Promise.resolve()
    }
    log(roleHolderLine(key, current))
    return delay(interval, options.signal).then(poll)
  }
  return poll()
}

function acquireRole(
  store: LeaseStore,
  key: string,
  holder: LeaseHolder,
  ttlMs: number,
  options: HoldRoleLeaseOptions
): Promise<Lease> {
  const attempt = (): Promise<Lease> =>
    waitForRole(store, key, ttlMs, options).then(() => {
      const acquired = store.acquire(key, holder, ttlMs)
      if (acquired.ok) {
        return acquired.lease
      }
      return attempt()
    })
  return attempt()
}

export async function holdRoleLease(
  store: LeaseStore,
  role: 'loop' | 'drive',
  holder: LeaseHolder,
  ttlMs: number,
  options: HoldRoleLeaseOptions = {}
): Promise<{ release: () => void }> {
  const key = `role/${role}`
  let lease = await acquireRole(store, key, holder, ttlMs, options)
  let released = false
  const log = options.log ?? console.error
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let timer: ReturnType<typeof setInterval>
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    clearInterval(timer)
    options.signal?.removeEventListener('abort', aborted)
    store.release(lease)
  }
  const aborted = (): void => {
    options.onAbort?.()
    release()
  }
  const lost = (): void => {
    if (released) {
      return
    }
    released = true
    clearInterval(timer)
    options.signal?.removeEventListener('abort', aborted)
    log(`${key} lease lost — exiting`)
    options.onLost?.()
    exit(75)
  }
  timer = setInterval(() => {
    const renewed = store.renew(lease, ttlMs)
    if (renewed === undefined) {
      lost()
      return
    }
    lease = renewed
  }, Math.max(1, ttlMs / 3))
  timer.unref()
  options.signal?.addEventListener('abort', aborted, { once: true })
  if (options.signal?.aborted) {
    aborted()
    throw new RoleLeaseAbortedError('role lease acquisition aborted')
  }
  return { release }
}
