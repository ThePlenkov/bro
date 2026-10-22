import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { gitCommonDir } from './git.ts'
import { remoteUrl } from './connectors.ts'

interface RemoteParts {
  host: string
  path: string[]
}

function stripSuffix(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? ''
}

function parseScpAddress(remote: string): RemoteParts | undefined {
  const at = remote.indexOf('@')
  const userSeparator = at < 0 ? -1 : remote.indexOf(':', at + 1)
  const hostStart = userSeparator < 0 ? 0 : at + 1
  const separator = userSeparator < 0 ? remote.indexOf(':') : userSeparator
  if (separator < 0) {
    return undefined
  }
  const authority = remote.slice(0, separator)
  const host = authority.slice(hostStart)
  const path = remote.slice(separator + 1)
  if (authority.includes('/')) {
    return undefined
  }
  if (host === '') {
    return undefined
  }
  if (path === '') {
    return undefined
  }
  return {
    host: host.toLowerCase(),
    path: path.split('/').filter((part) => part !== ''),
  }
}

function scpRemote(value: string): RemoteParts | undefined {
  if (value.includes('://')) {
    return undefined
  }
  return parseScpAddress(stripSuffix(value))
}

function urlRemote(value: string): RemoteParts {
  const parsed = new URL(value.includes('://') ? value : `https://${value}`)
  return {
    host: parsed.hostname.toLowerCase(),
    path: parsed.pathname.split('/').filter((part) => part !== ''),
  }
}

function dropProxyPrefix(parts: RemoteParts): RemoteParts {
  if (!parts.host.includes('git-manager')) {
    return parts
  }
  const index = parts.path.indexOf('proxy')
  if (index < 0) {
    return parts
  }
  const host = parts.path[index + 1]
  if (host === undefined) {
    return parts
  }
  return {
    host: host.toLowerCase(),
    path: parts.path.slice(index + 2),
  }
}

function canonicalRemote(parts: RemoteParts): string {
  const path = parts.path.join('/').replace(/\.git$/i, '')
  return path === '' ? parts.host : `${parts.host}/${path}`
}

export function normalizeRemote(url: string): string {
  const value = url.trim()
  const scp = scpRemote(value)
  const parts = dropProxyPrefix(scp ?? urlRemote(value))
  return canonicalRemote(parts)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function projectId(dir: string): string {
  const remote = remoteUrl(dir)
  if (remote !== undefined) {
    return digest(normalizeRemote(remote))
  }
  const common = gitCommonDir(dir)
  if (common === null) {
    throw new Error(`cannot identify project in ${dir} — no origin or git common dir`)
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from the repository's git common dir
  return digest(realpathSync(common))
}
