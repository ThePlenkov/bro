/**
 * mesh peers — the transport seam (specs/mesh). A peer binding is
 * `{ rig, remote }`; the transport is derived from the remote shape:
 *
 *   local         remote is a same-machine checkout path — the peer's
 *                 live beads store is queried via `bd -C` (no pull, no
 *                 publish requirement; 5nnj's bilateral case)
 *   beads-remote  remote is a git URL — the peer's store is pulled
 *                 read-only from refs/dolt/data into a local dolt
 *                 replica (the mesh default)
 *   github        remote is a github.com URL — the issue is the
 *                 thread, a comment carries the record; the binding's
 *                 `login` is the account that speaks for the rig
 *   wasteland     remote is a wl:// (or wasteland://) commons address
 *                 — reads hit the board, never the rig's own fork
 *
 * An explicit `transport` field on the entry overrides the derivation
 * — a github-hosted remote that IS a dolt replica source pins
 * `beads-remote` back explicitly.
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseGithubRemote } from './github.ts'
import { formatRigUri, parseRigUri } from './identity.ts'

export const TRANSPORTS = ['local', 'beads-remote', 'github', 'wasteland'] as const
export type MeshTransport = (typeof TRANSPORTS)[number]

export interface MeshPeer {
  alias: string
  rig: string
  remote: string
  transport: MeshTransport
  /** the account that speaks for this rig on account-authenticated
   *  planes (github) — absent ⇒ that plane admits nothing and says so */
  login?: string
}

/** remote → transport. A filesystem path (or file:// URL) naming a
 *  live checkout — `.beads` present — is the `local` binding; a path
 *  naming a bare git remote is `beads-remote` (its refs/dolt/data is
 *  what gets cloned). A github.com URL is the `github` issue plane;
 *  `wl://`/`wasteland://` names a commons board. Everything else
 *  URL-shaped is beads-remote. */
export function transportOf(remote: string, explicit?: string): MeshTransport | null {
  if (explicit !== undefined) {
    return (TRANSPORTS as readonly string[]).includes(explicit)
      ? (explicit as MeshTransport)
      : null
  }
  if (isAbsolute(remote) || remote.startsWith('file://') || remote.startsWith('.')) {
    const path = remote.startsWith('file://') ? remote.slice('file://'.length) : remote
    return existsSync(path) && existsSync(`${path}/.beads`) ? 'local' : 'beads-remote'
  }
  if (parseGithubRemote(remote) !== null) {
    return 'github'
  }
  if (/^(?:wl|wasteland):\/\//.test(remote)) {
    return 'wasteland'
  }
  return 'beads-remote'
}

/** The local checkout path a `local` peer's remote names — file:// is
 *  unwrapped; anything that doesn't resolve to a directory is a config
 *  error the caller reports, not a silent skip. */
export function localCheckout(remote: string): string | null {
  const path = remote.startsWith('file://') ? remote.slice('file://'.length) : remote
  return existsSync(path) ? path : null
}

export function parsePeer(alias: string, raw: unknown): MeshPeer | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const e = raw as { rig?: unknown; remote?: unknown; transport?: unknown; login?: unknown }
  if (
    typeof e.rig !== 'string' ||
    parseRigUri(e.rig) === null ||
    typeof e.remote !== 'string' ||
    e.remote === ''
  ) {
    return null
  }
  const transport = transportOf(e.remote, typeof e.transport === 'string' ? e.transport : undefined)
  if (transport === null) {
    return null
  }
  const rig = parseRigUri(e.rig)
  return {
    alias,
    rig: formatRigUri(rig!),
    remote: e.remote,
    transport,
    ...(typeof e.login === 'string' && e.login !== '' ? { login: e.login } : {}),
  }
}
