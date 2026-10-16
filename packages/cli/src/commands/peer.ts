/** Loopback peer attribution — which local process is on the other end
 *  of an accepted connection, resolved through the process tree.
 *
 *  The conductor serves agents that are local siblings (claude, devin,
 *  codex, bro…). W3C traceparent is honored when sent, but most callers
 *  don't propagate — so the caller's identity comes from the socket:
 *  /proc/net/tcp maps (remotePort → socket inode), fd dirs under /proc
 *  map inode → pid, and /proc/<pid>/stat walks ppid up to init. The chain
 *  names the agent even when the caller is a shim inside a shim —
 *  `peer.agent` is the first recognized name walking the tree DOWN,
 *  `peer.tree` the full `comm>comm>…` path, `peer.cmd` the peer's
 *  executable (argv[0] basename — arguments can carry prompts and
 *  credentials and never enter span attributes). */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import type { Socket } from 'node:net'

const AGENT =
  /^(claude|devin|codex|cursor-agent|cursor|opencode|sverka|bro|bd|pi|aider|gemini|qwen|crush|amp|goose)/i

export interface PeerInfo {
  pid: number
  comm: string
  cmd: string
  tree: string[]
  agent?: string
}

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')

/** (remotePort on our socket, localPort listener) → inode of the peer's
 *  socket. /proc/net/tcp lists every row from the OWNING process's view:
 *  the peer's row has local_address = :remotePort, rem = :localPort. */
function peerInode(remotePort: number, localPort: number): string | undefined {
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string
    try {
      rows = readFileSync(table, 'utf8')
    } catch {
      continue
    }
    for (const line of rows.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || f[1] === 'local_address') continue
      const [, lport] = (f[1] ?? '').split(':')
      const [, rport] = (f[2] ?? '').split(':')
      if (lport === hex(remotePort) && rport === hex(localPort) && f[3] === '01') {
        return f[9]
      }
    }
  }
  return undefined
}

/** socket inode → owning pid (scan fd symlinks under /proc/<pid>). */
function inodePid(inode: string): number | undefined {
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue
    const fdDir = `/proc/${p}/fd`
    let fds: string[]
    try {
      fds = readdirSync(fdDir)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`${fdDir}/${fd}`) === `socket:[${inode}]`) return Number(p)
      } catch {
        // fd vanished mid-scan — keep walking
      }
    }
  }
  return undefined
}

interface ProcRow {
  pid: number
  ppid: number
  comm: string
}

function procRow(pid: number): ProcRow | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const open = s.indexOf('(')
    const close = s.lastIndexOf(')')
    return {
      pid,
      comm: s.slice(open + 1, close),
      ppid: Number(s.slice(close + 2).split(' ')[1]),
    }
  } catch {
    return undefined
  }
}

/** argv[0]'s basename only — the full cmdline can carry prompts,
 *  tokens and client secrets; arguments stay out of telemetry. */
function cmdline(pid: number): string {
  try {
    return basename(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '')
  } catch {
    return ''
  }
}

/** Per-socket memo — a keep-alive socket serves many requests and the
 *  /proc scan is paid once per connection, not once per request. */
const PEER_CACHE = new WeakMap<Socket, PeerInfo | undefined>()

/** Resolve the process on the other end of a loopback socket. */
export function peerInfo(sock: Socket): PeerInfo | undefined {
  const cached = PEER_CACHE.get(sock)
  if (cached !== undefined) return cached
  const resolved = resolvePeer(sock)
  PEER_CACHE.set(sock, resolved)
  return resolved
}

function resolvePeer(sock: Socket): PeerInfo | undefined {
  const { remotePort, localPort } = sock
  if (remotePort === undefined || localPort === undefined) return undefined
  const inode = peerInode(remotePort, localPort)
  if (inode === undefined) return undefined
  const pid = inodePid(inode)
  if (pid === undefined) return undefined

  const tree: string[] = []
  let agent: string | undefined
  let cur = procRow(pid)
  let hops = 0
  while (cur !== undefined && hops < 24) {
    tree.push(cur.comm)
    if (agent === undefined && AGENT.test(cur.comm)) agent = cur.comm
    if (cur.ppid <= 1 || cur.ppid === cur.pid) break
    cur = procRow(cur.ppid)
    hops++
  }
  return { pid, comm: procRow(pid)?.comm ?? '', cmd: cmdline(pid).slice(0, 200), tree, agent }
}

/** Flat attrs for spans/log metadata — empty object when unresolvable. */
export function peerAttrs(sock: Socket): Record<string, string | number> {
  const p = peerInfo(sock)
  if (p === undefined) return {}
  return {
    'peer.pid': p.pid,
    'peer.comm': p.comm,
    'peer.cmd': p.cmd,
    'peer.tree': p.tree.join('>'),
    ...(p.agent === undefined ? {} : { 'peer.agent': p.agent }),
  }
}
