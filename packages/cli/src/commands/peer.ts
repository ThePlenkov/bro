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
 *  credentials and never enter span attributes).
 *
 *  Linux reads stay synchronous filesystem probes; darwin's legs are
 *  subprocess spawns (lsof/ps) and run OFF the event loop — the first
 *  request on a socket seeds an async resolve, keep-alive requests
 *  after it read the cached answer. */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Socket } from 'node:net';

const execFileP = promisify(execFile);

const AGENT =
  /^(claude|devin|codex|cursor-agent|cursor|opencode|sverka|bro|bd|pi|aider|gemini|qwen|crush|amp|goose)/i;

export interface PeerInfo {
  pid: number;
  comm: string;
  cmd: string;
  tree: string[];
  agent?: string;
}

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

function readTcpTableLinux(
  table: string,
  remotePort: number,
  localPort: number
): string | undefined {
  let rows: string;
  try {
    rows = readFileSync(table, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of rows.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[1] === 'local_address') continue;
    const [, lport] = (f[1] ?? '').split(':');
    const [, rport] = (f[2] ?? '').split(':');
    if (lport === hex(remotePort) && rport === hex(localPort) && f[3] === '01') {
      return f[9];
    }
  }
  return undefined;
}

/** The port field of an lsof endpoint — everything after the last
 *  ':', so v4, bracketed v6 and hostnames all compare the same. */
function endpointPort(endpoint: string): string {
  return endpoint.slice(endpoint.lastIndexOf(':') + 1);
}

/** The host field of an lsof endpoint or a node socket address —
 *  normalized so the spellings compare: bracketed v6 unwrapped,
 *  `localhost` and v4-mapped `::ffff:` folded to the numeric form lsof
 *  `-n` prints. '' stays '' — an unprintable host can never match. */
function endpointHost(addr: string | undefined): string {
  if (addr === undefined) return '';
  let h = addr.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return '127.0.0.1';
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (v4 !== null) return v4[1];
  if (h === '0:0:0:0:0:0:0:1') return '::1';
  return h;
}

/** One lsof TCP line's endpoint pair → the owning `mac:<pid>` when the
 *  row is the peer's socket — matched on ADDRESS AND PORT both ways so
 *  an IPv4 and an IPv6 client sharing a port pair can't attribute each
 *  other's PID. */
function peerInodeDarwinMatch(
  out: string,
  remotePort: number,
  localPort: number,
  remoteHost: string,
  localHost: string
): string | undefined {
  for (const line of out.split('\n')) {
    if (!line.includes('TCP') || !line.includes('->')) continue;
    const nameIdx = line.indexOf('TCP');
    const afterTcp = line.slice(nameIdx);
    const arrowIdx = afterTcp.indexOf('->');
    if (arrowIdx === -1) continue;
    const left = afterTcp.slice(0, arrowIdx).trim();
    const right = afterTcp
      .slice(arrowIdx + 2)
      .replace(/\s*\(.*\)\s*$/, '')
      .trim();
    // The peer's row has local = its end (remotePort from our view) and
    // remote = ours (localPort); lsof prints host:port — the endpoint
    // split after the last ':' never misreads adjacent digits, and the
    // host half disambiguates v4/v6 twins on the same port pair.
    if (endpointPort(left) !== String(remotePort)) continue;
    if (endpointHost(left.slice(0, left.lastIndexOf(':'))) !== remoteHost) continue;
    if (endpointPort(right) !== String(localPort)) continue;
    if (endpointHost(right.slice(0, right.lastIndexOf(':'))) !== localHost) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length > 1 && /^\d+$/.test(parts[1])) {
      return `mac:${parts[1]}`;
    }
  }
  return undefined;
}

/** (remotePort on our socket, localPort listener) → inode of the peer's
 *  socket. /proc/net/tcp lists every row from the OWNING process's view:
 *  the peer's row has local_address = :remotePort, rem = :localPort. */
function peerInode(remotePort: number, localPort: number): string | undefined {
  if (process.platform === 'linux') {
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const found = readTcpTableLinux(table, remotePort, localPort);
      if (found) return found;
    }
    return undefined;
  }
  return undefined;
}

/** socket inode → owning pid (scan fd symlinks under /proc/<pid>). */
function inodePid(inode: string): number | undefined {
  if (process.platform === 'linux') {
    return inodePidLinux(inode);
  }
  if (process.platform === 'darwin' && inode.startsWith('mac:')) {
    return Number(inode.slice(4));
  }
  return undefined;
}

function inodePidLinux(inode: string): number | undefined {
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    if (fdDirHasSocket(`/proc/${p}/fd`, inode)) return Number(p);
  }
  return undefined;
}

/** Any fd symlink under fdDir resolving to `socket:[inode]`. */
function fdDirHasSocket(fdDir: string, inode: string): boolean {
  let fds: string[];
  try {
    fds = readdirSync(fdDir);
  } catch {
    return false;
  }
  const target = `socket:[${inode}]`;
  for (const fd of fds) {
    try {
      if (readlinkSync(`${fdDir}/${fd}`) === target) return true;
    } catch {
      // fd vanished mid-scan — keep walking
    }
  }
  return false;
}

interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
}

function procRowLinux(pid: number): ProcRow | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = s.indexOf('(');
    const close = s.lastIndexOf(')');
    return {
      pid,
      comm: s.slice(open + 1, close),
      ppid: Number(s.slice(close + 2).split(' ')[1]),
    };
  } catch {
    return undefined;
  }
}

function procRow(pid: number): ProcRow | undefined {
  if (process.platform === 'linux') {
    return procRowLinux(pid);
  }
  return undefined;
}

/** argv[0]'s basename only — the full cmdline can carry prompts,
 *  tokens and client secrets; arguments stay out of telemetry. */
function cmdline(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return basename(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '');
    } catch {
      return '';
    }
  }
  return '';
}

/** Per-socket memo — a keep-alive socket serves many requests and the
 *  /proc scan is paid once per connection, not once per request. */
const PEER_CACHE = new WeakMap<Socket, PeerInfo | undefined>();
/** Resolution attempts per socket — a failed lookup retries only so
 *  many times before the socket stops paying for probes it can't use. */
const PEER_ATTEMPTS = new WeakMap<Socket, number>();
const PEER_PENDING = new WeakSet<Socket>();
const PEER_MAX_ATTEMPTS = 2;

/** Resolve the process on the other end of a loopback socket. */
export function peerInfo(sock: Socket): PeerInfo | undefined {
  if (PEER_CACHE.has(sock)) return PEER_CACHE.get(sock);
  if (process.platform === 'darwin') {
    // lsof/ps are subprocess spawns — never on the event loop. The
    // first request on a socket seeds the async resolve and keeps no
    // attrs; the answer lands in the cache for the requests after.
    seedPeerLookup(sock);
    return undefined;
  }
  const resolved = resolvePeer(sock);
  PEER_CACHE.set(sock, resolved);
  return resolved;
}

function seedPeerLookup(sock: Socket): void {
  if (PEER_PENDING.has(sock)) return;
  const attempts = PEER_ATTEMPTS.get(sock) ?? 0;
  if (attempts >= PEER_MAX_ATTEMPTS) return;
  PEER_ATTEMPTS.set(sock, attempts + 1);
  PEER_PENDING.add(sock);
  void resolvePeerAsync(sock)
    .then(r => {
      if (r !== undefined) PEER_CACHE.set(sock, r);
    })
    .catch(() => undefined)
    .finally(() => PEER_PENDING.delete(sock));
}

function resolvePeer(sock: Socket): PeerInfo | undefined {
  const { remotePort, localPort } = sock;
  if (remotePort === undefined || localPort === undefined) return undefined;
  const inode = peerInode(remotePort, localPort);
  if (inode === undefined) return undefined;
  const pid = inodePid(inode);
  if (pid === undefined) return undefined;

  const tree: string[] = [];
  let agent: string | undefined;
  let cur = procRow(pid);
  let hops = 0;
  while (cur !== undefined && hops < 24) {
    tree.push(cur.comm);
    if (agent === undefined && AGENT.test(cur.comm)) agent = cur.comm;
    if (cur.ppid <= 1 || cur.ppid === cur.pid) break;
    cur = procRow(cur.ppid);
    hops++;
  }
  return { pid, comm: procRow(pid)?.comm ?? '', cmd: cmdline(pid).slice(0, 200), tree, agent };
}

// --- darwin async legs -----------------------------------------------------------

/** `cmd <args>` stdout — async twin of the execFileSync legs so the
 *  subprocess never blocks the server loop. Rejects on failure or
 *  timeout; callers own the fallback. */
async function execOut(cmd: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { encoding: 'utf8', timeout });
  return stdout;
}

async function peerInodeDarwinAsync(
  remotePort: number,
  localPort: number,
  remoteHost: string,
  localHost: string
): Promise<string | undefined> {
  try {
    const out = await execOut('lsof', ['-nP', '-i', 'TCP', '-sTCP:ESTABLISHED'], 1000);
    return peerInodeDarwinMatch(out, remotePort, localPort, remoteHost, localHost);
  } catch {
    return undefined;
  }
}

async function procRowAsync(pid: number): Promise<ProcRow | undefined> {
  try {
    const out = await execOut('ps', ['-o', 'pid=,ppid=,comm=', '-p', String(pid)], 500);
    const m = out.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return undefined;
    return { pid: Number(m[1]), ppid: Number(m[2]), comm: basename(m[3].trim()) };
  } catch {
    return undefined;
  }
}

/** argv[0]'s basename only — arguments can carry prompts and
 *  credentials and never enter span attributes. */
async function cmdlineAsync(pid: number): Promise<string> {
  try {
    const out = await execOut('ps', ['-o', 'command=', '-p', String(pid)], 500);
    const first = out.trim().split(/\s+/)[0] ?? '';
    return basename(first);
  } catch {
    return '';
  }
}

/** The full async resolve — same walk as resolvePeer, but every
 *  subprocess leg awaits instead of blocking the loop. */
async function resolvePeerAsync(sock: Socket): Promise<PeerInfo | undefined> {
  const { remotePort, localPort, remoteAddress, localAddress } = sock;
  if (remotePort === undefined || localPort === undefined) return undefined;
  const inode = await peerInodeDarwinAsync(
    remotePort,
    localPort,
    endpointHost(remoteAddress),
    endpointHost(localAddress)
  );
  if (inode === undefined) return undefined;
  const pid = inodePid(inode);
  if (pid === undefined) return undefined;

  const tree: string[] = [];
  let agent: string | undefined;
  let cur = await procRowAsync(pid);
  let hops = 0;
  while (cur !== undefined && hops < 24) {
    tree.push(cur.comm);
    if (agent === undefined && AGENT.test(cur.comm)) agent = cur.comm;
    if (cur.ppid <= 1 || cur.ppid === cur.pid) break;
    cur = await procRowAsync(cur.ppid);
    hops++;
  }
  return {
    pid,
    comm: (await procRowAsync(pid))?.comm ?? '',
    cmd: (await cmdlineAsync(pid)).slice(0, 200),
    tree,
    agent,
  };
}

/** Flat attrs for spans/log metadata — empty object when unresolvable. */
export function peerAttrs(sock: Socket): Record<string, string | number> {
  const p = peerInfo(sock);
  if (p === undefined) return {};
  return {
    'peer.pid': p.pid,
    'peer.comm': p.comm,
    'peer.cmd': p.cmd,
    'peer.tree': p.tree.join('>'),
    ...(p.agent === undefined ? {} : { 'peer.agent': p.agent }),
  };
}
