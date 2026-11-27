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
  annotations_url?: unknown;
}

function api(repo: string, path: string): unknown {
  const result = ghTry(['api', `repos/${repo}/${path}`]);
  if (result.code !== 0) {
    throw new CommandError(`gh api failed: ${result.err}`, EXIT.failure);
  }
  try {
    return JSON.parse(result.out) as unknown;
  } catch {
    throw new CommandError(`gh api returned invalid JSON for ${path}`, EXIT.failure);
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

export function collectAnnotations(target: PrTarget): ActAnnotations {
  const pull = api(target.repo, `pulls/${target.pr}`);
  const headSha =
    pull !== null &&
    typeof pull === 'object' &&
    typeof (pull as { head?: { sha?: unknown } }).head?.sha === 'string'
      ? (pull as { head: { sha: string } }).head.sha
      : '';
  if (headSha === '')
    throw new CommandError('PR response did not contain a head sha', EXIT.failure);

  const runs = checksFrom(api(target.repo, `commits/${headSha}/check-runs`));
  const checks: CheckAnnotations[] = [];
  for (const run of runs) {
    const url = typeof run.annotations_url === 'string' ? run.annotations_url : null;
    const rows = url === null ? [] : annotationsFromUrl(url);
    if (rows.length > 0 || run.conclusion === 'failure') {
      checks.push({ name: stringField(run.name, '(unnamed check)'), annotations: rows });
    }
  }
  return { pr: target.pr, head_sha: headSha, checks };
}

function annotationsFromUrl(url: string): CheckAnnotation[] {
  const result = ghTry(['api', url]);
  if (result.code !== 0) throw new CommandError(`gh api failed: ${result.err}`, EXIT.failure);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.out) as unknown;
  } catch {
    throw new CommandError('gh api returned invalid annotation JSON', EXIT.failure);
  }
  return Array.isArray(parsed) ? parsed.map(annotation) : [];
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
