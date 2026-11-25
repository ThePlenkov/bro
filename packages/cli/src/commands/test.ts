/** `bro test` — the scoped dev-side test lane (spec bead bro-6xjvb).
 *
 * `npm test` is the whole nx suite — 240+ files, 20 minutes — and CI
 * must keep paying it. A worker verifying a three-file fix needs the
 * same tsx harness over just the files its change touches. This verb
 * is that lane: substring filters over the repo's *.test.ts inventory,
 * one `node --import tsx --test` spawn, exit code propagated. It is a
 * dev convenience, never a CI gate — the full suite stays the gate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repo root the verb walks — the cwd's git toplevel when inside a
 *  worktree, else cwd. Tests are addressed root-relative so a filter
 *  matches the same file from any directory in the repo. */
function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

/** Every *.test.ts under packages/ and plugins/ — the walk is
 *  directory-shallow (node_modules and dist skipped) and finishes in
 *  milliseconds on this repo's scale. e2e files are included only with
 *  --e2e: they spawn real processes and cost minutes each. */
const SKIP_DIRS = new Set(['node_modules', 'dist']);

function skippableDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function testFile(name: string, includeE2e: boolean): boolean {
  if (!name.endsWith('.test.ts')) {
    return false;
  }
  return includeE2e || !name.endsWith('.e2e.test.ts');
}

function walkTests(dir: string, includeE2e: boolean, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skippableDir(e.name)) {
        walkTests(p, includeE2e, out);
      }
    } else if (testFile(e.name, includeE2e)) {
      out.push(p);
    }
  }
}

export function inventory(root: string, includeE2e: boolean): string[] {
  const out: string[] = [];
  for (const base of ['packages', 'plugins']) {
    const b = join(root, base);
    if (existsSync(b) && statSync(b).isDirectory()) {
      walkTests(b, includeE2e, out);
    }
  }
  return out.sort();
}

/** Filter semantics: each argument is a substring matched against the
 *  root-relative path — `bro test act-wait` selects every test file
 *  whose path carries it. A file matching ANY argument is selected. */
export function select(files: string[], root: string, filters: string[]): string[] {
  return files.filter(f => {
    const rel = f.slice(root.length + 1);
    return filters.some(w => rel.includes(w));
  });
}

export function runTestCommand(argv: string[]): void {
  const includeE2e = argv.includes('--e2e');
  const filters = argv.filter(a => !a.startsWith('--'));
  if (filters.length === 0) {
    console.error(
      'usage: bro test <substring…> [--e2e] — the scoped dev lane; the full suite stays `npm test`'
    );
    process.exit(2);
  }
  const root = repoRoot();
  const all = inventory(root, includeE2e);
  const picked = select(all, root, filters);
  if (picked.length === 0) {
    console.error(
      `bro test: no test file matches ${filters.map(f => `"${f}"`).join(', ')} — ` +
        `${all.length} files in inventory`
    );
    process.exit(2);
  }
  console.error(
    `bro test: ${picked.length} file(s) — ${picked.map(p => p.slice(root.length + 1)).join(', ')}`
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...picked], {
    stdio: 'inherit',
    cwd: root,
  });
  process.exit(r.status ?? 1);
}
