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

function git(root: string, args: string[], input?: string): GitResult {
  const r = spawnSync('git', ['-C', root, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function remoteSha(root: string, remote: string): string | undefined {
  const r = git(root, ['ls-remote', remote, CEILING_REMOTE_REF]);
  if (r.status !== 0) return undefined;
  const sha = r.stdout.trim().split(/\s+/)[0];
  return sha || undefined;
}

function isEntry(value: unknown): value is RemoteCeilingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<RemoteCeilingEntry>;
  return typeof entry.id === 'string' && typeof entry.pid === 'number' && typeof entry.ts === 'number';
}

function readEntries(root: string, remote: string, sha: string | undefined): RemoteCeilingEntry[] {
  if (sha === undefined) return [];
  const fetched = git(root, [
    'fetch',
    '--quiet',
    remote,
    `${CEILING_REMOTE_REF}:${CEILING_REMOTE_REF}`,
  ]);
  if (fetched.status !== 0) throw new Error('ceiling remote fetch failed');
  const r = git(root, ['show', `${sha}:reservations.json`]);
  if (r.status !== 0) throw new Error('ceiling remote ledger is corrupt');
  const parsed: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) throw new Error('ceiling remote ledger is corrupt');
  return parsed.filter(isEntry);
}

function commitLedger(root: string, entries: RemoteCeilingEntry[], parent?: string): string {
  const blob = git(root, ['hash-object', '-w', '--stdin'], JSON.stringify(entries));
  if (blob.status !== 0) throw new Error('ceiling ledger blob failed');
  const tree = git(root, ['mktree'], `100644 blob ${blob.stdout.trim()}\treservations.json\n`);
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
      root,
      'commit-tree',
      tree.stdout.trim(),
      ...(parent ? ['-p', parent] : []),
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
    const before = remoteSha(root, remote);
    if (before === undefined && git(root, ['remote', 'get-url', remote]).status !== 0) return null;
    let entries: RemoteCeilingEntry[];
    try {
      entries = readEntries(root, remote, before).filter(
        e => now - e.ts < ENTRY_TTL_MS && (e.branch === undefined || !activeBranches.has(e.branch))
      );
    } catch {
      return null;
    }
    if (open + entries.length >= max) return 'remote-held';
    const id = `${pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const commit = commitLedger(root, [...entries, { id, pid, branch, ts: now }], before);
    const lease = `--force-with-lease=${CEILING_REMOTE_REF}:${before ?? ''}`;
    const pushed = git(root, ['push', '--quiet', lease, remote, `${commit}:${CEILING_REMOTE_REF}`]);
    if (pushed.status === 0) return `remote:${root}:${id}`;
  }
  // A reachable remote that kept changing is still a held slot. Falling
  // through to the common-dir file here would reintroduce the cross-clone
  // race this plane exists to close.
  return 'remote-held';
}

type LedgerUpdate = (entries: RemoteCeilingEntry[], id: string) => RemoteCeilingEntry[];

function updateRemoteLedger(handle: string, update: LedgerUpdate): boolean {
  const match = /^remote:(.*):([^:]+)$/.exec(handle);
  if (!match) return false;
  const [, root, id] = match;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = remoteSha(root, 'origin');
    if (before === undefined) return false;
    let entries: RemoteCeilingEntry[];
    try {
      entries = update(readEntries(root, 'origin', before), id);
    } catch {
      return false;
    }
    const commit = commitLedger(root, entries, before);
    if (
      git(root, [
        'push',
        '--quiet',
        `--force-with-lease=${CEILING_REMOTE_REF}:${before}`,
        'origin',
        `${commit}:${CEILING_REMOTE_REF}`,
      ]).status === 0
    )
      return true;
  }
  return false;
}

export function releaseRemoteCeiling(handle: string): boolean {
  return updateRemoteLedger(handle, (entries, id) => entries.filter(e => e.id !== id));
}

export function stampRemoteCeiling(handle: string, branch: string): boolean {
  return updateRemoteLedger(handle, (entries, id) =>
    entries.map(e => (e.id === id ? { ...e, branch } : e))
  );
}
