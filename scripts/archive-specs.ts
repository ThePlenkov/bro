/** Dry-run-first retirement of closed, unreferenced legacy bead specs. */
import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');

export type BeadStatus = 'closed' | 'open' | 'unknown';
export interface SpecCandidate {
  id: string;
  path: string;
  closed: boolean;
  referenced: boolean;
  reason: 'archive' | 'open' | 'referenced' | 'unknown';
}

const KNOWN_STATUSES = new Set<string>(['closed', 'open']);
const BEAD_SPEC = /^bro-[\w.-]+\.md$/;
const WORDS = /[A-Za-z0-9_.-]+/g;

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
  return {
    id: input.id,
    path: input.path,
    closed: input.status === 'closed',
    referenced: input.referenced,
    reason: reasonOf(input.status, input.referenced),
  };
}

function rowStatus(row: unknown): [string, BeadStatus] | [] {
  if (typeof row !== 'object' || row === null || !('id' in row)) return [];
  const item = row as { id?: unknown; status?: unknown };
  return typeof item.id === 'string' ? [[item.id, statusOf(item.status)]] : [];
}

/** Absolute path to bd, resolved against PATH once — security scanners
 *  (S4036) reject PATH-resolved spawns; same contract as core's gitBin. */
function bdBin(): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = `${dir}/bd`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep walking PATH
    }
  }
  return 'bd';
}

function beadStatuses(): Map<string, BeadStatus> {
  try {
    const output = execFileSync(bdBin(), ['list', '--all', '--json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) return new Map();
    const statuses = new Map<string, BeadStatus>();
    for (const row of rows) {
      const result = rowStatus(row);
      if (result.length > 0) statuses.set(result[0][0], result[0][1]);
    }
    return statuses;
  } catch {
    return new Map();
  }
}

class Repository {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private filesIn(dir: string): string[] {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap(entry => {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return this.filesIn(path);
      return entry.isFile() ? [path] : [];
    });
  }

  private read(path: string): string | undefined {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(path, 'r');
      const size = fs.fstatSync(descriptor).size;
      if (!Number.isSafeInteger(size) || size > 64 * 1024 * 1024) return undefined;
      const content = Buffer.alloc(size);
      fs.readSync(descriptor, content, 0, size, 0);
      return content.toString('utf8');
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private candidates(): string[] {
    const specs = join(this.root, 'specs');
    try {
      return fs
        .readdirSync(specs, { withFileTypes: true })
        .filter(entry => entry.isFile() && BEAD_SPEC.test(entry.name))
        .map(entry => join('specs', entry.name));
    } catch {
      return [];
    }
  }

  private referrerFiles(): string[] {
    const roots = [
      join(this.root, 'docs'),
      join(this.root, 'site', 'content'),
    ];
    const files = roots.flatMap(root => this.filesIn(root));
    const specs = join(this.root, 'specs');
    try {
      files.push(
        ...fs
          .readdirSync(specs, { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
          .map(entry => join(specs, entry.name))
      );
    } catch {
      // A repository without specs has no spec referrers.
    }
    for (const name of ['README.md', 'AGENTS.md']) {
      const path = join(this.root, name);
      if (fs.existsSync(path)) files.push(path);
    }
    return files;
  }

  private referencedIn(file: string, ids: Set<string>, candidate: string): string[] {
    const relativePath = relative(this.root, file);
    if (relativePath.startsWith(`specs${sep}archive${sep}`)) return [];
    const words = this.read(file)?.match(WORDS) ?? [];
    return words
      .map(word => word.endsWith('.md') ? word.slice(0, -3) : word)
      .filter(word => ids.has(word) && relativePath !== candidate);
  }

  references(candidates: string[]): Set<string> {
    const ids = new Set(candidates.map(path => basename(path, '.md')));
    const referenced = new Set<string>();
    for (const file of this.referrerFiles()) {
      const relativePath = relative(this.root, file);
      for (const word of this.referencedIn(file, ids, relativePath)) {
        referenced.add(word);
      }
    }
    return referenced;
  }

  scan(): SpecCandidate[] {
    const paths = this.candidates();
    const referenced = this.references(paths);
    const statuses = beadStatuses();
    return paths.map(path => {
      const id = basename(path, '.md');
      return classifySpec({
        id,
        path,
        status: statuses.get(id) ?? 'unknown',
        referenced: referenced.has(id),
      });
    });
  }
}

/** Check references with one repository walk; retained as part of the script API. */
export function isReferenced(root: string, candidate: string, id: string): boolean {
  const repository = new Repository(root);
  const relativeCandidate = relative(repository.root, resolve(repository.root, candidate));
  return repository.references([relativeCandidate]).has(id);
}

export function scan(root: string): SpecCandidate[] {
  return new Repository(root).scan();
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function applyMoves(root: string, rows: SpecCandidate[]): void {
  const archive = join(root, 'specs', 'archive');
  const moves = rows.filter(row => row.reason === 'archive');
  if (moves.length === 0) return;
  fs.mkdirSync(archive, { recursive: true });
  moves.forEach((row, index) => {
    const source = join(root, row.path);
    const destination = join(archive, basename(row.path));
    const temporary = `${destination}.tmp.${process.pid}.${index}`;
    fs.renameSync(source, temporary);
    try {
      fs.linkSync(temporary, destination);
      fs.unlinkSync(temporary);
    } catch (error) {
      try {
        fs.renameSync(temporary, source);
      } catch {
        // Preserve the original failure; an operator can recover the temp file.
      }
      if (isNodeError(error, 'EEXIST')) {
        throw new Error(`archive destination already exists: ${relative(root, destination)}`);
      }
      throw error;
    }
  });
}

function printRow(row: SpecCandidate, apply: boolean): void {
  const arrow = apply && row.reason === 'archive' ? ' -> specs/archive/' : '';
  console.log(`${row.reason.padEnd(10)} ${row.path}${arrow}`);
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
