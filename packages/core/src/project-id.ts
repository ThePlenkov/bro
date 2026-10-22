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

function scpRemote(value: string): RemoteParts | undefined {
  if (value.includes('://')) {
    return undefined
  }
  const match = stripSuffix(value).match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  if (match === null) {
    return undefined
  }
  return {
    host: match[1]!.toLowerCase(),
    path: match[2]!.split('/').filter((part) => part !== ''),
  }
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
  if (index < 0 || index + 1 >= parts.path.length) {
    return parts
  }
  return {
    host: parts.path[index + 1]!.toLowerCase(),
    path: parts.path.slice(index + 2),
  }
}

function canonicalRemote(parts: RemoteParts): string {
  const path = parts.path.join('/').replace(/\.git$/i, '')
  return `${parts.host}/${path}`.replace(/\/+$/, '')
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
  return digest(realpathSync(common))
}
