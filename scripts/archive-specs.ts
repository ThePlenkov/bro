/** Dry-run-first retirement of closed, unreferenced legacy bead specs. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BeadStatus = 'closed' | 'open' | 'unknown';
export interface SpecCandidate {
  id: string;
  path: string;
  closed: boolean;
  referenced: boolean;
  reason: 'archive' | 'open' | 'referenced' | 'unknown';
}

const KNOWN_STATUSES = new Set<string>(['closed', 'open']);

function statusOf(raw: unknown): BeadStatus {
  return typeof raw === 'string' && KNOWN_STATUSES.has(raw) ? (raw as BeadStatus) : 'unknown';
}

function reasonOf(status: BeadStatus, referenced: boolean): SpecCandidate['reason'] {
  if (status === 'open') return 'open';
  if (status === 'unknown') return 'unknown';
  return referenced ? 'referenced' : 'archive';
}

export function classifySpec(input: {
  id: string;
  path: string;
  status: BeadStatus;
  referenced: boolean;
}): SpecCandidate {
  const { id, path, status, referenced } = input;
  return {
    id,
    path,
    closed: status === 'closed',
    referenced,
    reason: reasonOf(status, referenced),
  };
}

function rowStatus(row: unknown): [string, BeadStatus] | [] {
  if (typeof row !== 'object' || row === null || !('id' in row)) return [];
  const item = row as { id?: unknown; status?: unknown };
  if (typeof item.id !== 'string') return [];
  return [[item.id, statusOf(item.status)]];
}

function beadStatuses(): Map<string, BeadStatus> {
  try {
    const output = execFileSync('bd', ['list', '--all', '--json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) return new Map();
    return new Map(rows.flatMap(rowStatus));
  } catch {
    return new Map();
  }
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage', '.nx', 'archive']);

function filesUnder(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) return [];
      return filesUnder(root, join(dir, entry.name));
    }
    return entry.isFile() ? [relative(root, join(dir, entry.name))] : [];
  });
}

/** Resolve inside the repo only — anything escaping root is not read. */
function insideRoot(root: string, file: string): string | undefined {
  const path = resolve(root, file);
  if (path !== root && !path.startsWith(root + sep)) return undefined;
  return path;
}

function fileMentions(root: string, file: string, id: string): boolean {
  const path = insideRoot(root, file);
  if (path === undefined) return false;
  try {
    return readFileSync(path, 'utf8').includes(id);
  } catch {
    return false;
  }
}

export function isReferenced(root: string, candidate: string, id: string): boolean {
  const candidatePath = resolve(root, candidate);
  return filesUnder(root, root).some(file => {
    if (resolve(root, file) === candidatePath) return false;
    if (file.startsWith('specs/archive/')) return false;
    return fileMentions(root, file, id);
  });
}

function candidates(root: string): string[] {
  const specs = join(root, 'specs');
  return readdirSync(specs, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^bro-[\w.-]+\.md$/.test(entry.name))
    .map(entry => join('specs', entry.name));
}

export function scan(root: string): SpecCandidate[] {
  const statuses = beadStatuses();
  return candidates(root).map(path => {
    const id = basename(path, '.md');
    return classifySpec({
      id,
      path,
      status: statuses.get(id) ?? 'unknown',
      referenced: isReferenced(root, path, id),
    });
  });
}

function printRow(row: SpecCandidate, apply: boolean): void {
  const arrow = apply && row.reason === 'archive' ? ' -> specs/archive/' : '';
  console.log(`${row.reason.padEnd(10)} ${row.path}${arrow}`);
}

function applyMoves(root: string, rows: SpecCandidate[]): void {
  const archive = join(root, 'specs', 'archive');
  const moves = rows.filter(item => item.reason === 'archive');
  if (moves.length > 0) mkdirSync(archive, { recursive: true });
  for (const row of moves) {
    const destination = join(archive, basename(row.path));
    if (existsSync(destination)) {
      throw new Error(`archive destination already exists: ${relative(root, destination)}`);
    }
    renameSync(join(root, row.path), destination);
  }
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const apply = process.argv.includes('--apply');
  const rows = scan(root);
  for (const row of rows) printRow(row, apply);
  if (!apply) {
    const count = rows.filter(row => row.reason === 'archive').length;
    console.log(`dry-run: ${count} candidate(s); use --apply to move them`);
    return;
  }
  applyMoves(root, rows);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
