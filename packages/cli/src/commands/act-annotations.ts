import { CommandError, EXIT, ensureAuth, ghTry, reviewHost, type PrTarget } from '@broject/core';
import { resolvePr } from './act-args.ts';

export interface CheckAnnotation {
  level: string;
  path: string;
  line: number | null;
  title: string;
}

export interface CheckAnnotations {
  name: string;
  annotations: CheckAnnotation[];
}

export interface ActAnnotations {
  pr: number;
  head_sha: string;
  checks: CheckAnnotations[];
}

interface CheckRun {
  name?: unknown;
  conclusion?: unknown;
  output?: { annotations_url?: unknown };
}

function api(repo: string, path: string): unknown {
  return apiWithArgs([`repos/${repo}/${path}`], path);
}

function paginatedApi(repo: string, path: string): unknown[] {
  const result = apiWithArgs(['--paginate', '--slurp', `repos/${repo}/${path}?per_page=100`], path);
  if (!Array.isArray(result)) {
    throw new CommandError(`gh api returned invalid paginated JSON for ${path}`, EXIT.error);
  }
  return result;
}

function apiWithArgs(args: string[], path: string): unknown {
  const result = ghTry(['api', ...args]);
  if (result.code !== 0) {
    throw new CommandError(`gh api failed: ${result.err}`, EXIT.error);
  }
  try {
    return JSON.parse(result.out) as unknown;
  } catch {
    throw new CommandError(`gh api returned invalid JSON for ${path}`, EXIT.error);
  }
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function annotation(value: unknown): CheckAnnotation {
  const row = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const line = row.start_line ?? row.line;
  return {
    level: stringField(row.annotation_level, 'notice'),
    path: stringField(row.path, '-'),
    line: typeof line === 'number' ? line : null,
    title: stringField(row.title, '(untitled)'),
  };
}

function checksFrom(value: unknown): CheckRun[] {
  if (value === null || typeof value !== 'object') return [];
  const rows = (value as { check_runs?: unknown }).check_runs;
  return Array.isArray(rows)
    ? rows.filter((row): row is CheckRun => row !== null && typeof row === 'object')
    : [];
}

function headShaFrom(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const head = (value as { head?: unknown }).head;
  if (head === null || typeof head !== 'object') return '';
  const sha = (head as { sha?: unknown }).sha;
  return typeof sha === 'string' ? sha : '';
}

function paginatedCheckRuns(pages: unknown[]): CheckRun[] {
  return pages.flatMap(page => checksFrom(page));
}

function checkAnnotations(run: CheckRun): CheckAnnotations | null {
  const url =
    run.output !== undefined && typeof run.output.annotations_url === 'string'
      ? run.output.annotations_url
      : null;
  const rows = url === null ? [] : annotationsFromUrl(url);
  if (rows.length === 0 && run.conclusion !== 'failure') return null;
  return { name: stringField(run.name, '(unnamed check)'), annotations: rows };
}

export function collectAnnotations(target: PrTarget): ActAnnotations {
  const headSha = headShaFrom(api(target.repo, `pulls/${target.pr}`));
  if (headSha === '')
    throw new CommandError('PR response did not contain a head sha', EXIT.error);

  const runs = paginatedCheckRuns(
    paginatedApi(target.repo, `commits/${headSha}/check-runs`)
  );
  const checks = runs
    .map(checkAnnotations)
    .filter((check): check is CheckAnnotations => check !== null);
  return { pr: target.pr, head_sha: headSha, checks };
}

function annotationsFromUrl(url: string): CheckAnnotation[] {
  const pages = apiWithArgs(['--paginate', '--slurp', `${url}?per_page=100`], url);
  if (!Array.isArray(pages)) {
    throw new CommandError(`gh api returned invalid paginated JSON for ${url}`, EXIT.error);
  }
  return pages.flatMap(page => (Array.isArray(page) ? page.map(annotation) : []));
}

export async function cmdAnnotations(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() });
  const rev = reviewHost();
  const target = resolvePr(rev, argv);
  const result = collectAnnotations(target);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const check of result.checks) {
    console.log(check.name);
    for (const row of check.annotations) {
      console.log(`  ${row.level}\t${row.path}:${row.line ?? '-'}\t${row.title}`);
    }
  }
}
