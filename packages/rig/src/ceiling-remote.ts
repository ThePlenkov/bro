import { spawnSync } from 'node:child_process';

export const CEILING_REMOTE_REF = 'refs/bro/ceiling/ledger';
const ENTRY_TTL_MS = 30 * 60_000;

export interface RemoteCeilingEntry {
  id: string;
  pid: number;
  branch?: string;
  ts: number;
}

type GitResult = { status: number | null; stdout: string; stderr: string };

interface GitRequest {
  root: string;
  args: string[];
  input?: string;
}

function git(request: GitRequest): GitResult {
  const r = spawnSync('git', ['-C', request.root, ...request.args], {
    input: request.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface RemoteRefRequest {
  root: string;
  remote: string;
}

function remoteSha(request: RemoteRefRequest): string | undefined {
  const r = git({ ...request, args: ['ls-remote', request.remote, CEILING_REMOTE_REF] });
  if (r.status !== 0) return undefined;
  const sha = r.stdout.trim().split(/\s+/)[0];
  return sha || undefined;
}

function isEntry(value: unknown): value is RemoteCeilingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<RemoteCeilingEntry>;
  return typeof entry.id === 'string' && typeof entry.pid === 'number' && typeof entry.ts === 'number';
}

interface LedgerReadRequest extends RemoteRefRequest {
  sha: string | undefined;
}

function readEntries(request: LedgerReadRequest): RemoteCeilingEntry[] {
  if (request.sha === undefined) return [];
  const fetched = git({
    root: request.root,
    args: ['fetch', '--quiet', request.remote, `${CEILING_REMOTE_REF}:${CEILING_REMOTE_REF}`],
  });
  if (fetched.status !== 0) throw new Error('ceiling remote fetch failed');
  const r = git({
    root: request.root,
    args: ['show', `${request.sha}:reservations.json`],
  });
  if (r.status !== 0) throw new Error('ceiling remote ledger is corrupt');
  const parsed: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) throw new Error('ceiling remote ledger is corrupt');
  return parsed.filter(isEntry);
}

interface LedgerCommitRequest {
  root: string;
  entries: RemoteCeilingEntry[];
  parent?: string;
}

function commitLedger(request: LedgerCommitRequest): string {
  const blob = git({
    root: request.root,
    args: ['hash-object', '-w', '--stdin'],
    input: JSON.stringify(request.entries),
  });
  if (blob.status !== 0) throw new Error('ceiling ledger blob failed');
  const tree = git({
    root: request.root,
    args: ['mktree'],
    input: `100644 blob ${blob.stdout.trim()}\treservations.json\n`,
  });
  if (tree.status !== 0) throw new Error('ceiling ledger tree failed');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'bro',
    GIT_AUTHOR_EMAIL: 'bro@localhost',
    GIT_COMMITTER_NAME: 'bro',
    GIT_COMMITTER_EMAIL: 'bro@localhost',
  };
  const commit = spawnSync(
    'git',
    [
      '-C',
      request.root,
      'commit-tree',
      tree.stdout.trim(),
      ...(request.parent ? ['-p', request.parent] : []),
      '-m',
      'bro: ceiling reservation',
    ],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  if (commit.status !== 0) throw new Error('ceiling ledger commit failed');
  return (commit.stdout ?? '').trim();
}

/** CAS a reservation into one remote ref. The single ledger ref is important:
 * separate refs per pid would still let two clones both observe the same free
 * slot before creating their refs. */
export interface RemoteCeilingOptions {
  root: string;
  max: number;
  open: number;
  now: number;
  pid: number;
  branch?: string;
  activeBranches?: ReadonlySet<string>;
}

export function reserveRemoteCeiling(options: RemoteCeilingOptions): string | null {
  const { root, max, open, now, pid, branch, activeBranches = new Set<string>() } = options;
  const remote = 'origin';
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = remoteSha({ root, remote });
    if (before === undefined && git({ root, args: ['remote', 'get-url', remote] }).status !== 0)
      return null;
    let entries: RemoteCeilingEntry[];
    try {
      entries = readEntries({ root, remote, sha: before }).filter(
        e => now - e.ts < ENTRY_TTL_MS && (e.branch === undefined || !activeBranches.has(e.branch))
      );
    } catch {
      return null;
    }
    if (open + entries.length >= max) return 'remote-held';
    const id = `${pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const commit = commitLedger({
      root,
      entries: [...entries, { id, pid, branch, ts: now }],
      parent: before,
    });
    const lease = `--force-with-lease=${CEILING_REMOTE_REF}:${before ?? ''}`;
    const pushed = git({
      root,
      args: ['push', '--quiet', lease, remote, `${commit}:${CEILING_REMOTE_REF}`],
    });
    if (pushed.status === 0) return `remote:${root}:${id}`;
  }
  // A reachable remote that kept changing is still a held slot. Falling
  // through to the common-dir file here would reintroduce the cross-clone
  // race this plane exists to close.
  return 'remote-held';
}

type LedgerUpdate = (entries: RemoteCeilingEntry[], id: string) => RemoteCeilingEntry[];

interface LedgerUpdateRequest {
  handle: string;
  update: LedgerUpdate;
}

function updateRemoteLedger(request: LedgerUpdateRequest): boolean {
  const match = /^remote:(.*):([^:]+)$/.exec(request.handle);
  if (!match) return false;
  const [, root, id] = match;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = remoteSha({ root, remote: 'origin' });
    if (before === undefined) return false;
    let entries: RemoteCeilingEntry[];
    try {
      entries = request.update(readEntries({ root, remote: 'origin', sha: before }), id);
    } catch {
      return false;
    }
    const commit = commitLedger({ root, entries, parent: before });
    if (
      git({
        root,
        args: [
        'push',
        '--quiet',
        `--force-with-lease=${CEILING_REMOTE_REF}:${before}`,
        'origin',
        `${commit}:${CEILING_REMOTE_REF}`,
        ],
      }).status === 0
    )
      return true;
  }
  return false;
}

export interface RemoteCeilingHandle {
  handle: string;
}

export function releaseRemoteCeiling(request: RemoteCeilingHandle): boolean {
  return updateRemoteLedger({
    handle: request.handle,
    update: (entries, id) => entries.filter(e => e.id !== id),
  });
}

export interface RemoteCeilingStamp extends RemoteCeilingHandle {
  branch: string;
}

export function stampRemoteCeiling(request: RemoteCeilingStamp): boolean {
  return updateRemoteLedger({
    handle: request.handle,
    update: (entries, id) =>
      entries.map(e => (e.id === id ? { ...e, branch: request.branch } : e)),
  });
}
