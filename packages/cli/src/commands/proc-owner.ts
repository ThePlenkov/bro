/**
 * Session-owner liveness over /proc — the occupancy plane shared by
 * drive, hooks, and work markers.
 *
 * A `.work`/`work` marker's first line carries `<millis> [pid start]`.
 * Writers stamp the owning process (the agent ancestor for hook-armed
 * markers, the spawned child for connector markers) so readers can
 * prove liveness: a marker whose recorded owner is dead is residue the
 * moment the session dies, not after the freshness window expires
 * (bro-b87b), and a live owner keeps its marker past the window for a
 * >24h-idle session (bro-xlhm). Ownerless markers — old format, no
 * /proc, a human shell — fall back to the mtime window.
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  agentEntryBlocked,
  agentExitFileName,
  DARWIN_SCAN_BUDGET_MS,
  entryRunId,
  gitTry,
  handleOwner,
  markerLive,
  pidAlive,
  procStat,
  psEwwEnvTokens,
  psRegroupPaths,
  psTokenize,
  SESSION_SLOT_TTL_MS,
  type AgentRegistryEntry,
  type AgentState,
} from '@broject/core';

export interface ProcHit {
  pid: number;
  cmd: string;
}

/** Agent-shaped executable name — the fallback for sessions that never
 *  armed a marker. Checked against argv[0] (and argv[1] when argv[0] is
 *  a launcher like npx/node): matching inside arbitrary arguments would
 *  let `grep claude` occupy a worktree. An optional script extension
 *  covers `node devin.js`-style invocations. */
const AGENT_NAME_RE = /^(devin|claude|codex|gemini|aider|opencode|amp|omp)(\.\w+)?$/;
const AGENT_LAUNCHERS = new Set(['node', 'npx', 'bun', 'bunx', 'tsx', 'uvx', 'deno']);

/** True when the process's own argv names an agent — the executable or
 *  the launcher's script argument, never a free-floating argument. */
function procIsAgentCmd(dir: string): boolean {
  const argv = readProcText(dir, 'cmdline').split('\0');
  if (AGENT_NAME_RE.test(basename(argv[0] ?? ''))) {
    return true;
  }
  return (
    AGENT_LAUNCHERS.has(basename(argv[0] ?? '')) && AGENT_NAME_RE.test(basename(argv[1] ?? ''))
  );
}

/** Env badges agent runtimes pin on themselves — every descendant
 *  inherits them, so a detached tool shell counts even after a setsid
 *  broke the ancestry chain. NUL-anchored — /proc environ and the darwin
 *  `environ` path both NUL-join their tokens, so a whitespace boundary
 *  would only ever under-match, never fix one. */
const AGENT_ENV_RE = /(?:^|\0)(?:BRO_AGENT_ID|AI_AGENT)=/;

/** Platforms whose proc reads go through `ps`/`lsof` instead of /proc
 *  — darwin plus the BSDs the owner walk routes through the same
 *  helpers (a FreeBSD/OpenBSD entry without these legs reads '' for
 *  every file and the walk stops at the first pid). */
const PS_PLATFORMS = new Set(['darwin', 'freebsd', 'openbsd']);

/** `ps <args> -p <pid>` output — the darwin stand-in for /proc reads.
 *  Throws like execFileSync does; callers own the fallback chain. */
function psText(pid: string, args: string[], timeout = 500): string {
  return execFileSync(
    'ps', // NOSONAR — PATH lookup is the contract
    [...args, '-p', pid],
    { encoding: 'utf8', timeout }
  );
}

/** darwin/BSD cmdline — `args=` first, `command=` spellings after;
 *  fragments of a spaced absolute path are re-glued so the vector's
 *  boundaries survive where `ps`'s join loses them; the tokens NUL-join
 *  so the rest of the file parses one format. */
function darwinCmdline(pid: string): string {
  let out: string;
  try {
    out = psText(pid, ['-ww', '-o', 'args=']);
  } catch {
    try {
      out = psText(pid, ['-ww', '-o', 'command=']);
    } catch {
      try {
        out = psText(pid, ['-o', 'command=']);
      } catch {
        return '';
      }
    }
  }
  const tokens = psRegroupPaths(psTokenize(out));
  if (tokens.length === 0) return '';
  return tokens.join('\0') + '\0';
}

function darwinEnviron(pid: string): string {
  const tokens = psEwwEnvTokens(Number(pid));
  return tokens.length === 0 ? '' : tokens.join('\0') + '\0';
}

function darwinStatus(pid: string): string {
  try {
    const ppid = psText(pid, ['-o', 'ppid=']).trim();
    return `PPid:\t${ppid}\n`;
  } catch {
    return '';
  }
}

function readProcText(dir: string, file: string): string {
  // Injected trees are plain files — read them on every platform; only
  // the real /proc root falls back to platform tools, so a fixture pid
  // can never collide with the host's live process table.
  if (process.platform === 'linux' || dirname(dir) !== '/proc') {
    try {
      return readFileSync(join(dir, file), 'utf8');
    } catch {
      return '';
    }
  }
  const pid = basename(dir);
  if (!/^\d+$/.test(pid)) return '';
  if (PS_PLATFORMS.has(process.platform)) {
    try {
      if (file === 'cmdline') return darwinCmdline(pid);
      if (file === 'environ') return darwinEnviron(pid);
      if (file === 'status') return darwinStatus(pid);
    } catch {
      return '';
    }
  }
  return '';
}

/** ppid of a /proc entry — the `PPid:` line of status; 0 when unreadable. */
function procPpid(dir: string): number {
  const pid = basename(dir);
  if (process.platform === 'linux' || dirname(dir) !== '/proc') {
    const m = /^PPid:[ \t]*(\d+)/m.exec(readProcText(dir, 'status'));
    return m === null ? 0 : Number(m[1]);
  }
  if (PS_PLATFORMS.has(process.platform) && /^\d+$/.test(pid)) {
    try {
      const out = execFileSync(
        'ps', // NOSONAR — PATH lookup is the contract
        ['-o', 'ppid=', '-p', pid],
        {
          encoding: 'utf8',
          timeout: 500,
        }
      );
      const ppid = out.trim();
      return ppid === '' ? 0 : Number(ppid);
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Pid of the nearest agent-shaped process at-or-above `dir` — agent
 *  CLIs keep their own cwd at the launch dir while their tool shells
 *  (bash, node, git) are what cd into the worktree; bro-pywx's raced
 *  spawn was exactly that shape — the devin process sat in the main
 *  checkout, invisible to an own-cmdline-only scan. Bounded so a wedged
 *  or cyclic chain can never loop the pass. Null when no ancestor
 *  matches. */
function procAgentPid(dir: string, depth = 0): number | null {
  if (depth > 16) {
    return null;
  }
  if (procIsAgentProc(dir)) {
    return Number(basename(dir));
  }
  const ppid = procPpid(dir);
  if (ppid > 1) {
    // Stay under the current root — `/proc/<ppid>` spells the same
    // dir for the real tree, and an injected fixture tree keeps its
    // own files instead of escaping to the host's process table.
    return procAgentPid(join(dirname(dir), String(ppid)), depth + 1);
  }
  return null;
}

/** Agent shape by cmdline or env badge — the shared predicate behind
 *  procAgentPid (occupancy: nearest match suffices) and procAgentRoot
 *  (ownership: topmost match wins). */
function procIsAgentProc(dir: string): boolean {
  return procIsAgentCmd(dir) || AGENT_ENV_RE.test(readProcText(dir, 'environ'));
}

function nextProcDir(cur: string, ppid: number): string | null {
  if (ppid <= 1) return null;
  return join(dirname(cur), String(ppid));
}

/** The topmost agent-shaped ancestor — the owner tag's pid. The env
 *  badge is inherited by every descendant, so the NEAREST agent
 *  ancestor is usually a transient tool shell that exits mid-session
 *  while the session still works; a marker owned by it drops early and
 *  frees the worktree under a live session. The chain root outlives
 *  its tool shells, so the walk keeps climbing past matches. */
function procAgentRoot(dir: string): number | null {
  let top: number | null = null;
  let cur: string | null = dir;
  for (let depth = 0; depth <= 16 && cur !== null; depth++) {
    if (procIsAgentProc(cur)) {
      top = Number(basename(cur));
    }
    const ppid = procPpid(cur);
    cur = nextProcDir(cur, ppid);
  }
  return top;
}

function procIsAgent(dir: string): boolean {
  return procAgentPid(dir) !== null;
}

/** Monitor shape — a process that OBSERVES the repo but never works
 *  in the tree: bro's own watcher/status/serve verbs and act waits
 *  (bro-dkw3e). The badge is inherited from the spawning session, so
 *  the ancestry scan alone can't tell a monitor from a worker — this
 *  test reads the process's OWN argv. Shells stay workers: a bare
 *  bash inside the tree is indistinguishable from a raced worker's
 *  tool shell (bro-pywx), and false-positive beats false-negative. */
const MONITOR_VERBS = new Set(['watch', 'wait', 'status', 'serve', 'pulse', 'notify', 'daemon']);

function procIsMonitor(dir: string): boolean {
  const argv = readProcText(dir, 'cmdline').split('\0').filter(Boolean);
  const exe = basename(argv[0] ?? '');
  const positionals = argv.slice(1).filter(a => !a.startsWith('-'));
  // monitor verbs only count when the process is actually bro — exe
  // `bro`, a `bro` first positional under setsid/nohup/npx, or the
  // shipped `…/dist/index.js` entry. `node worker.js wait` carries a
  // monitor-ish arg but isn't bro — it stays a worker.
  const first = positionals[0] ?? '';
  const broShaped = exe === 'bro' || first === 'bro' || /[/\\]dist[/\\]index\.js$/.test(first);
  if (!broShaped) {
    return false;
  }
  // `node <dist>/index.js serve` — the script path is the entry, the
  // verb follows it; `bro watch` needs no drop
  const cmdTokens =
    exe !== 'bro' && /\.(?:js|ts|mjs|cjs)$/.test(first) ? positionals.slice(1) : positionals;
  return cmdTokens.some(t => MONITOR_VERBS.has(t));
}

/** One argv token rooted in the tree — absolute tokens always test
 *  against `inside` (a script the process executes from the tree roots
 *  it even when its cwd can't be read); relative tokens need the
 *  process cwd to resolve against, so they only apply when cwd read. */
function tokenRooted(cwd: string | null, tok: string, inside: (p: string) => boolean): boolean {
  if (tok === '') return false;
  if (tok.startsWith('/')) {
    try {
      return inside(tok);
    } catch {
      return false;
    }
  }
  return cwd !== null && cwd !== '' && inside(resolve(cwd, tok));
}

function processRootedInLinux(
  procDir: string,
  root: string,
  inside: (p: string) => boolean
): ProcHit[] {
  const hits: ProcHit[] = [];
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return hits;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue;
    }
    const dir = join(procDir, name);
    const cmdline = readProcText(dir, 'cmdline');
    let cwd: string | null;
    try {
      cwd = readlinkSync(join(dir, 'cwd'));
    } catch {
      cwd = null;
    }
    const tokens = cmdline.split('\0').filter(Boolean);
    const rooted =
      (cwd !== null && inside(cwd)) || tokens.some(tok => tokenRooted(cwd, tok, inside));
    if (rooted) {
      hits.push({ pid: Number(name), cmd: tokens.join(' ') });
    }
  }
  return hits;
}

function processRootedInProcOverride(
  procDir: string,
  root: string,
  inside: (p: string) => boolean
): ProcHit[] {
  const hits: ProcHit[] = [];
  try {
    const names = readdirSync(procDir);
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const dir = join(procDir, name);
      try {
        const cmdline = readProcText(dir, 'cmdline');
        let cwd: string | null;
        try {
          cwd = readlinkSync(join(dir, 'cwd'));
        } catch {
          cwd = null;
        }
        const tokens = cmdline.split('\0').filter(Boolean);
        const rooted =
          (cwd !== null && inside(cwd)) || tokens.some(tok => tokenRooted(cwd, tok, inside));
        if (rooted) {
          hits.push({ pid: Number(name), cmd: tokens.join(' ') });
        }
      } catch {
        continue;
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/** A procDir override holding numeric entries is a /proc-shaped test
 *  tree — read it instead of the platform tools. */
function procOverrideActive(procDir: string): boolean {
  if (procDir === '/proc') return false;
  try {
    return readdirSync(procDir).some(n => /^\d+$/.test(n));
  } catch {
    return false;
  }
}

/** Every pid `ps` can name — the scan set for the darwin walks. */
function darwinPids(): number[] {
  const out = execFileSync(
    'ps', // NOSONAR — PATH lookup is the contract
    ['-axo', 'pid='],
    { encoding: 'utf8', timeout: 2000 }
  );
  return out
    .split('\n')
    .filter(p => /^\d+$/.test(p.trim()))
    .map(p => Number(p.trim()));
}

/** one `lsof -Fn` batch → `p<pid>`/`n<path>` rows folded into the
 *  cwd map — the row parser, split out so the chunk loop stays flat */
function lsofCwdRows(lout: string, cwdMap: Map<number, string>): void {
  let currentPid: number | null = null;
  for (const l of lout.split('\n')) {
    if (l.startsWith('p')) {
      const v = Number(l.slice(1));
      currentPid = Number.isInteger(v) ? v : null;
      continue;
    }
    if (l.startsWith('n') && currentPid !== null) {
      cwdMap.set(currentPid, l.slice(1));
    }
  }
}

/** pid → cwd for a whole pid list, batched through chunked lsof runs.
 *  A failed chunk just leaves its pids to the per-pid fallback. */
function lsofCwdMap(pids: number[]): Map<number, string> {
  const cwdMap = new Map<number, string>();
  const chunkSize = 200;
  for (let i = 0; i < pids.length; i += chunkSize) {
    const chunk = pids.slice(i, i + chunkSize);
    try {
      const lout = execFileSync(
        'lsof', // NOSONAR — PATH lookup is the contract
        ['-a', '-d', 'cwd', '-Fn', '-p', chunk.join(',')],
        {
          encoding: 'utf8',
          timeout: 2000,
        }
      );
      lsofCwdRows(lout, cwdMap);
    } catch {
      // continue to next chunk
    }
  }
  return cwdMap;
}

/** pid → argv text, batched through chunked `ps -o pid=,args=` runs. */
function psArgsMap(pids: number[]): Map<number, string> {
  const cmdMap = new Map<number, string>();
  const chunkSize = 200;
  for (let i = 0; i < pids.length; i += chunkSize) {
    const chunk = pids.slice(i, i + chunkSize);
    try {
      const coutAll = execFileSync(
        'ps', // NOSONAR — PATH lookup is the contract
        ['-ww', '-o', 'pid=,args=', '-p', chunk.join(',')],
        {
          encoding: 'utf8',
          timeout: 2000,
        }
      );
      for (const l of coutAll.split('\n')) {
        const m = l.match(/^\s*(\d+)\s+(.*)$/s);
        if (m) {
          cmdMap.set(Number(m[1]), m[2] ?? '');
        }
      }
    } catch {
      // skip chunk — per-pid fallback covers the gap
    }
  }
  return cmdMap;
}

/** A pid's cwd — the batched answer first, then a per-pid lsof bounded
 *  by the scan deadline (each missing pid consuming its own timeout
 *  otherwise stacks a slow batch into a ~100s stall). null when lsof
 *  can't name a directory — the argv leg still gets to decide below. */
function darwinProcCwd(pid: number, cwdMap: Map<number, string>, deadline: number): string | null {
  const batched = cwdMap.get(pid);
  if (batched !== undefined && batched !== '') return batched;
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    const lout = execFileSync(
      'lsof', // NOSONAR — PATH lookup is the contract
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      {
        encoding: 'utf8',
        timeout: Math.min(500, left),
      }
    );
    return (
      lout
        .split('\n')
        .find(l => l.startsWith('n'))
        ?.slice(1) ?? ''
    );
  } catch {
    return null;
  }
}

/** A pid's argv — `args=` first, `command=` spelling after, '' when
 *  every ps spelling fails. */
function darwinArgs(pid: number): string {
  try {
    return execFileSync(
      'ps', // NOSONAR — PATH lookup is the contract
      ['-ww', '-o', 'args=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 500,
      }
    );
  } catch {
    try {
      return execFileSync(
        'ps', // NOSONAR — PATH lookup is the contract
        ['-ww', '-o', 'command=', '-p', String(pid)],
        {
          encoding: 'utf8',
          timeout: 500,
        }
      );
    } catch {
      return '';
    }
  }
}

/** One pid → a ProcHit when it roots in the tree, else null. cwd
 *  inside qualifies outright; argv tokens catch services executing
 *  tree files from elsewhere — and still get their say when the cwd
 *  read fails: a `node /wt/dist/index.js` run from anywhere roots the
 *  tree whether or not lsof could name a cwd for the pid. */
function rootedHit(
  pid: number,
  inside: (p: string) => boolean,
  cwdMap: Map<number, string>,
  cmdMap: Map<number, string>,
  deadline: number
): ProcHit | null {
  const cwd = darwinProcCwd(pid, cwdMap, deadline);
  const cout = cmdMap.get(pid) || darwinArgs(pid);
  const line = cout.replace(/\r?\n$/, '');
  const tokens = psRegroupPaths(psTokenize(line));
  const rooted =
    (cwd !== null && cwd !== '' && inside(cwd)) ||
    tokens.some(tok => tokenRooted(cwd, tok, inside));
  return rooted ? { pid, cmd: line.trim() } : null;
}

function processesRootedInDarwin(
  root: string,
  inside: (p: string) => boolean,
  procDir = '/proc'
): ProcHit[] {
  if (procOverrideActive(procDir)) {
    return processRootedInProcOverride(procDir, root, inside);
  }
  if (process.platform !== 'darwin') {
    return [];
  }
  const hits: ProcHit[] = [];
  try {
    const pids = darwinPids().filter(pid => pid !== process.pid);
    if (pids.length === 0) return hits;
    const deadline = Date.now() + DARWIN_SCAN_BUDGET_MS;
    const cwdMap = lsofCwdMap(pids);
    const cmdMap = psArgsMap(pids);
    for (const pid of pids) {
      try {
        const hit = rootedHit(pid, inside, cwdMap, cmdMap, deadline);
        if (hit !== null) hits.push(hit);
      } catch {
        continue;
      }
    }
    return hits;
  } catch {
    return hits;
  }
}

/** Live processes ROOTED in `worktree` — cwd inside, or an argv token
 *  that is a path inside the tree. The argv leg catches
 *  `node <wt>/dist/index.js serve`: the code a long-lived service is
 *  executing IS the tree even when its cwd sits elsewhere; removing
 *  the worktree strands a zombie running deleted files (bro-1usa8).
 *  Wider than agentProcessesIn by design — removal guards need every
 *  occupant, not only agent-shaped ones. A missing /proc reads as
 *  "no data" (same contract as agentProcessesIn). `procDir` injectable. */
export function processesRootedIn(worktree: string, procDir = '/proc'): ProcHit[] {
  const root = resolve(worktree);
  const inside = (p: string): boolean => p === root || p.startsWith(root + sep);
  if (process.platform !== 'linux' && procOverrideActive(procDir)) {
    return processRootedInProcOverride(procDir, root, inside);
  }
  if (process.platform === 'linux') {
    return processRootedInLinux(procDir, root, inside);
  }
  if (process.platform === 'darwin') {
    return processesRootedInDarwin(root, inside, procDir);
  }
  return [];
}

function agentProcessesInProcOverride(procDir: string, root: string): ProcHit[] {
  const hits: ProcHit[] = [];
  try {
    const names = readdirSync(procDir);
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const dir = join(procDir, name);
      try {
        let cwd: string;
        try {
          cwd = readlinkSync(join(dir, 'cwd'));
        } catch {
          continue;
        }
        if (cwd !== root && !cwd.startsWith(root + sep)) continue;
        if (procIsMonitor(dir)) continue;
        if (procIsAgent(dir)) {
          const cmd = readProcText(dir, 'cmdline').replaceAll('\0', ' ').trim();
          hits.push({ pid: Number(name), cmd });
        }
      } catch {
        continue;
      }
    }
    return hits;
  } catch {
    return hits;
  }
}

function agentProcessesInLinux(procDir: string, root: string): ProcHit[] {
  const hits: ProcHit[] = [];
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return hits;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue;
    }
    const dir = join(procDir, name);
    let cwd: string;
    try {
      cwd = readlinkSync(join(dir, 'cwd'));
    } catch {
      continue;
    }
    if (cwd !== root && !cwd.startsWith(root + sep)) {
      continue;
    }
    if (procIsMonitor(dir)) {
      continue;
    }
    if (procIsAgent(dir)) {
      const cmd = readProcText(dir, 'cmdline').replaceAll('\0', ' ').trim();
      hits.push({ pid: Number(name), cmd });
    }
  }
  return hits;
}

/** One pid → an agent ProcHit when it sits in the root and reads
 *  agent-shaped, else null. Unlike rootedHit there is no argv leg —
 *  occupancy requires the cwd inside, and a missing cwd drops the
 *  pid entirely. */
function agentHit(
  pid: number,
  root: string,
  cwdMap: Map<number, string>,
  deadline: number
): ProcHit | null {
  const cwd = darwinProcCwd(pid, cwdMap, deadline);
  if (!cwd || (cwd !== root && !cwd.startsWith(root + sep))) {
    return null;
  }
  const dir = join('/proc', String(pid));
  if (procIsMonitor(dir) || !procIsAgent(dir)) {
    return null;
  }
  return {
    pid,
    cmd: darwinArgs(pid)
      .replace(/\r?\n$/, '')
      .trim(),
  };
}

function agentProcessesInDarwin(root: string, procDir = '/proc'): ProcHit[] {
  if (procOverrideActive(procDir)) {
    return agentProcessesInProcOverride(procDir, root);
  }
  if (process.platform !== 'darwin') {
    return [];
  }
  const hits: ProcHit[] = [];
  try {
    const pids = darwinPids();
    if (pids.length === 0) return hits;
    const deadline = Date.now() + DARWIN_SCAN_BUDGET_MS;
    const cwdMap = lsofCwdMap(pids);
    for (const pid of pids) {
      if (pid === process.pid) continue;
      try {
        const hit = agentHit(pid, root, cwdMap, deadline);
        if (hit !== null) hits.push(hit);
      } catch {
        continue;
      }
    }
    return hits;
  } catch {
    return hits;
  }
}

/** Live agent-shaped processes with cwd inside `worktree` — Linux-only
 *  layer; a missing /proc is "no data", not "occupied" (the facade and
 *  marker planes still apply). `procDir` is injectable for tests. */
export function agentProcessesIn(worktree: string, procDir = '/proc'): ProcHit[] {
  const root = resolve(worktree);
  if (process.platform !== 'linux' && procOverrideActive(procDir)) {
    return agentProcessesInProcOverride(procDir, root);
  }
  if (process.platform === 'linux') {
    return agentProcessesInLinux(procDir, root);
  }
  if (process.platform === 'darwin') {
    return agentProcessesInDarwin(root, procDir);
  }
  return [];
}

let cachedOwner: { pid: number; start: string } | null | undefined;

/** This process's owning agent — the topmost agent-shaped ancestor.
 *  A `bro` invocation runs as a tool-call child (bro → shell → agent),
 *  so the recorded pid must be the session root's, not our own (ours
 *  dies when the CLI exits) and not the nearest badged ancestor's
 *  (a tool shell that exits mid-session). Null when no ancestor is
 *  agent-shaped (human
 *  shell, CI, no /proc, or an ancestor whose start won't read) — the
 *  caller's marker then stays ownerless and readers keep the mtime
 *  fallback. A start-less owner is strictly worse than none: it keeps
 *  a marker live past the window under a reused pid while still
 *  suppressing the freshness check. Cached per process: hooks arm
 *  markers on every tool call and the owner never changes. */
export function agentOwner(): { pid: number; start: string } | null {
  if (cachedOwner === undefined) {
    let pid: number | null = null;
    if (
      process.platform === 'darwin' ||
      process.platform === 'freebsd' ||
      process.platform === 'openbsd'
    ) {
      // On macOS/BSD without /proc, walk using pid dirs the helpers can handle
      pid = procAgentRoot(join('/proc', String(process.ppid)));
    } else if (existsSyncProc()) {
      pid = procAgentRoot(`/proc/${process.ppid}`);
    }
    const start = pid === null ? '' : (procStat(pid)?.start ?? '');
    cachedOwner = pid === null || start === '' ? null : { pid, start };
  }
  return cachedOwner;
}

function existsSyncProc(): boolean {
  try {
    statSync('/proc');
    return true;
  } catch {
    return false;
  }
}

/** Line-1 suffix writers append to a session/work marker:
 *  ` <pid> <start>` of the owning agent, '' when none is found. */
export function ownerTag(): string {
  const o = agentOwner();
  return o === null ? '' : ` ${o.pid} ${o.start}`;
}

// markerOwner/markerLive live in @broject/core — the marker-liveness
// read is shared with connectors (learn's previous-trace exclusion
// needs the same verdict) and can't import from the cli layer.
export { markerLive, markerOwner } from '@broject/core';

// --- marker-dir occupancy plane ---------------------------------------------------
//
// The pieces below judge "is a session/agent still alive behind this
// claim?" — shared by drive's occupancy pass, the loop litter sweep's
// dead-claim release, and watch/status check-ins. They live here
// because drive.ts and work.ts import each other transitively and
// proc-owner is the leaf both can reach.

/** The freshness horizon for `.work` markers — same as hooks.ts's
 *  LIVE_SESSION_MS: a marker younger than this names a live session. */
export const LIVE_MARKER_MS = 24 * 60 * 60 * 1000;

/** `<git-common-dir>/bro/hooks` — the session marker dir shared across
 *  every linked worktree. Null when git can't name the common dir. */
export function hooksDirOf(root: string): string | null {
  const r = gitTry(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.code === 0 ? r.out.trim() : '';
  return common === '' ? null : join(common, 'bro', 'hooks');
}

/** A `.work`/`.task` marker's detail may be a bead id, a slug, a
 *  worktree path or basename. Match conservatively — an over-match
 *  costs a skipped pass; an under-match costs a raced owner. */
export function detailMatches(
  detail: string,
  ctx: { branch: string; slug: string; worktree?: string }
): boolean {
  if (detail === ctx.branch || detail === ctx.slug) {
    return true;
  }
  if (ctx.worktree === undefined) {
    return false;
  }
  const base = basename(ctx.worktree);
  return detail === base || base.endsWith(`--${detail}`) || detail.endsWith(`/${base}`);
}

/** A live session marker's detail line with the marker's activity
 *  stamp — mtimeMs is the file's own mtime, which the arm rewrites on
 *  every arm-worthy command, so it reads as "last proven activity" for
 *  the merge-path TTL (bro-ihnlv). Undefined only when the stat that
 *  just proved the marker live raced it away. */
export interface WorkEntry {
  detail: string;
  mtimeMs?: number;
  /** The session that wrote the marker — the marker's file name minus
   *  its aspect suffix. The detail lines do not name their writer, and
   *  a caller that must address a session needs to know whose marker
   *  this is. */
  session?: string;
}

/** Every detail line of every live session marker WITH its stamp —
 *  liveWorkEntries is the mtime-carrying twin of liveWorkDetails. */
export function liveWorkEntries(
  dir: string,
  suffixes: readonly string[] = ['.work'],
  now: number = Date.now()
): WorkEntry[] {
  const entries: WorkEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const f of files) {
    if (!suffixes.some(s => f.endsWith(s))) {
      continue;
    }
    entries.push(...markerEntries(dir, f, now));
  }
  return entries;
}

/** One marker file's detail lines — empty when the marker is not live or
 *  unreadable. The session is the file's name minus its aspect suffix:
 *  the detail lines do not name their writer. */
function markerEntries(dir: string, file: string, now: number): WorkEntry[] {
  try {
    const path = join(dir, file);
    const mtimeMs = statSync(path).mtimeMs;
    const lines = readFileSync(path, 'utf8').split('\n');
    if (!markerLive(lines[0], mtimeMs, LIVE_MARKER_MS, now)) {
      return [];
    }
    const dot = file.lastIndexOf('.');
    const session = dot > 0 ? file.slice(0, dot) : undefined;
    return lines
      .slice(1)
      .map(line => line.trim())
      .filter(d => d !== '')
      .map(detail => ({ detail, mtimeMs, session }));
  } catch {
    // unreadable marker — skip
    return [];
  }
}

/** Every detail line of every live session marker — a session claiming
 *  two beads keeps both, so occupancy reads them all (a first-line peek
 *  would miss the second). Liveness is owner-pid first (bro-b87b: a
 *  dead session's marker is residue even when fresh), mtime-window
 *  fallback for ownerless markers. `suffixes` widens the scan past
 *  `.work` — the litter sweep also reads `.task` (the `bd --claim`
 *  arm). */
export function liveWorkDetails(
  dir: string,
  suffixes: readonly string[] = ['.work'],
  now: number = Date.now()
): string[] {
  return liveWorkEntries(dir, suffixes, now).map(e => e.detail);
}

/** An .exit file not yet harvested into the registry is death proof too
 *  — basename-only ids: '../' must never escape the agents home. */
function exitFileProves(home: string | null, e: AgentRegistryEntry): boolean {
  if (home === null || typeof e.agentId !== 'string' || basename(e.agentId) !== e.agentId) {
    return false;
  }
  try {
    const v = readFileSync(join(home, agentExitFileName(e.agentId, entryRunId(e))), 'utf8').trim();
    return v !== '' && Number.isInteger(Number(v));
  } catch {
    // no exit file — not proof
    return false;
  }
}

/** The attempt handle is the worker's own liveness proof — a runId'd
 *  native worker publishes `<agentId>.<runId>.handle` before its payload
 *  runs, so a live pid in it means a running worker even when the
 *  launcher's pid patch never landed (spec bro-l8c4f.5). The handle's
 *  published starttime decides identity, so a recycled pid never proves
 *  the worker; a bare legacy pid stays unverifiable and fail-opens.
 *  Same basename-only guard as the exit file. */
function handleFileProves(home: string | null, e: AgentRegistryEntry): boolean {
  const runId = entryRunId(e);
  if (
    home === null ||
    runId === undefined ||
    typeof e.agentId !== 'string' ||
    basename(e.agentId) !== e.agentId
  ) {
    return false;
  }
  try {
    const owner = handleOwner(readFileSync(join(home, `${e.agentId}.${runId}.handle`), 'utf8'));
    return owner !== null && pidAlive(owner.pid, owner.start);
  } catch {
    // no usable handle — not proof
    return false;
  }
}

/** A pid-less native row read by the handshake (spec bro-l8c4f.5): a
 *  live self-published handle IS the worker even with no pid patch;
 *  inside the handoff window the attempt can still land it ('spawned'),
 *  past it the attempt is dead ('lost'). */
function nativePidlessState(home: string | null, e: AgentRegistryEntry): AgentState {
  if (handleFileProves(home, e)) {
    return 'running';
  }
  return entryRunId(e) !== undefined && Date.now() - Date.parse(e.spawnedAt) < SESSION_SLOT_TTL_MS
    ? 'spawned'
    : 'lost';
}

/** Agent liveness derived from the registry entry alone — no backend
 *  list() probes. A live pid is running; a recorded or on-disk death is
 *  terminal; anything unproven counts as live ('spawned') — occupied is
 *  always the safe verdict, and a false-occupied only costs a skipped
 *  pass. */
export function registryEntryState(home: string | null, e: AgentRegistryEntry): AgentState {
  const pid = typeof e.pid === 'number' ? e.pid : undefined;
  // '' pidStart is unverified identity, not reuse proof — pidAlive('')
  // can never match a real starttime and would read a live agent dead
  const start = typeof e.pidStart === 'string' && e.pidStart !== '' ? e.pidStart : undefined;
  if (pid !== undefined && pidAlive(pid, start)) {
    return 'running';
  }
  if (e.stopped === true) {
    return 'stopped';
  }
  if (e.exitStatus !== undefined) {
    // recorded cause decides — a budget-walled entry reads 'blocked'
    // here the same as in the connector ladder (bro-7xgk.2)
    return agentEntryBlocked(e) ? 'blocked' : 'exited';
  }
  if (exitFileProves(home, e)) {
    return 'exited';
  }
  // a dead pid is proven — 'lost' keeps the fixer respawn-able; a
  // pid-less entry (remote backend) is unproven → conservative live.
  // Native is the exception: the handshake bounds a runId'd row's
  // pid-less window — the worker self-publishes its handle inside
  // SESSION_SLOT_TTL_MS or the attempt is dead, and a live handle IS
  // the worker even with no pid patch (spec bro-l8c4f.5)
  if (pid === undefined && e.backend === 'native') {
    return nativePidlessState(home, e);
  }
  return pid !== undefined ? 'lost' : 'spawned';
}

/** Claim-liveness verdict on a registry entry — the litter sweep's
 *  reading: running/spawned/blocked all mean the claim has a live
 *  owner (a blocked agent's claim is real — its resetAt will lift and
 *  it continues the same work); only exited/stopped/lost release. */
export function registryEntryHoldsClaim(home: string | null, e: AgentRegistryEntry): boolean {
  const s = registryEntryState(home, e);
  return s === 'running' || s === 'spawned' || s === 'blocked';
}
