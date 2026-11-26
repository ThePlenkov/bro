/** Dry-run-first retirement of closed, unreferenced legacy bead specs. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BeadStatus = 'closed' | 'open' | 'unknown';
export interface SpecCandidate {
  id: string;
  path: string;
  closed: boolean;
  referenced: boolean;
  reason: 'archive' | 'open' | 'referenced' | 'unknown';
}

export function classifySpec(input: {
  id: string;
  path: string;
  status: BeadStatus;
  referenced: boolean;
}): SpecCandidate {
  const { id, path, status, referenced } = input;
  const reason =
    status !== 'closed'
      ? status === 'unknown'
        ? 'unknown'
        : 'open'
      : referenced
        ? 'referenced'
        : 'archive';
  return { id, path, closed: status === 'closed', referenced, reason };
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
    return new Map(
      rows.flatMap(row => {
        if (typeof row !== 'object' || row === null || !('id' in row)) return [];
        const item = row as { id?: unknown; status?: unknown };
        const status = item.status === 'closed' || item.status === 'open' ? item.status : 'unknown';
        return typeof item.id === 'string' ? [[item.id, status] as const] : [];
      })
    );
  } catch {
    return new Map();
  }
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage', '.nx', 'archive']);
function filesUnder(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) return [];
      return filesUnder(root, join(dir, entry.name));
    }
    return entry.isFile() ? [relative(root, join(dir, entry.name))] : [];
  });
}

export function isReferenced(root: string, candidate: string, id: string): boolean {
  const candidatePath = resolve(root, candidate);
  return filesUnder(root, root).some(file => {
    const path = resolve(root, file);
    if (path === candidatePath || file.startsWith('specs/archive/')) return false;
    try {
      return readFileSync(path, 'utf8').includes(id);
    } catch {
      return false;
    }
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

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const apply = process.argv.includes('--apply');
  const rows = scan(root);
  for (const row of rows)
    console.log(
      `${row.reason.padEnd(10)} ${row.path}${apply && row.reason === 'archive' ? ' -> specs/archive/' : ''}`
    );
  if (!apply) {
    console.log(
      `dry-run: ${rows.filter(row => row.reason === 'archive').length} candidate(s); use --apply to move them`
    );
    return;
  }
  const archive = join(root, 'specs', 'archive');
  if (rows.some(row => row.reason === 'archive')) mkdirSync(archive, { recursive: true });
  for (const row of rows.filter(item => item.reason === 'archive')) {
    const destination = join(archive, basename(row.path));
    if (existsSync(destination))
      throw new Error(`archive destination already exists: ${relative(root, destination)}`);
    renameSync(join(root, row.path), destination);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
