/**
 * Multi-source debt collectors — pluggable feeds into the same ledger as
 * merged-PR review threads. Alert-style sources produce one record per
 * open finding with a stable `thread_id` (`<source>:<number>`) so repeated
 * collects dedup via the ledger's thread_id upsert. `source` tags the row
 * so `bro debt sync` labels beads `debt:<source>`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghJson } from '@broject/core';
import type { DebtPriority, DebtRecord } from './types.ts';
import { bodyPreview, deriveArea, fingerprint } from './text.ts';
import { collectCodacy, dedupeCodacyThreads } from './codacy.ts';
import { collectCodescene, dedupeCodesceneThreads } from './codescene.ts';
import { collectSonarcloud, dedupeReviewThreads } from './sonarcloud.ts';

export const DEBT_SOURCES = [
  'dependabot',
  'code-scanning',
  'secret-scanning',
  'stale-prs',
  'failed-ci',
  'sonarcloud',
  'codacy',
  'codescene',
  'sverka',
] as const;
export type DebtSource = (typeof DEBT_SOURCES)[number];

/** A configured source whose prerequisites are missing (token, project
 *  key) — collect skips it with a remediation line, never "failed", and
 *  never runs the upstream-resolve pass on an empty fetch. */
export class SourceSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceSkipped';
  }
}

export const ALL_SOURCES = ['review-threads', ...DEBT_SOURCES] as const;
export type DebtSourceName = (typeof ALL_SOURCES)[number];

export function parseSources(raw: unknown): DebtSourceName[] {
  if (!Array.isArray(raw)) return ['review-threads'];
  const valid = new Set<string>(ALL_SOURCES);
  const out = raw.filter((s): s is DebtSourceName => typeof s === 'string' && valid.has(s));
  return out.length > 0 ? out : ['review-threads'];
}

export interface CollectCtx {
  repo: string;
  runId: string;
  harvestedAt: string;
  /** Checkout root for source-specific config files
   *  (sonar-project.properties). Defaults to cwd at the use site. */
  dir?: string;
  /** `debt.sourceConfig` from bro.config — per-source knob bags a
   *  collector reads by its own name (`sourceConfig.sonarcloud`),
   *  ignored by the rest. Field validation is the collector's job. */
  sourceConfig?: Record<string, Record<string, unknown>>;
}

/** `gh api --paginate --slurp` — all pages of a list endpoint as one flat
 *  array. Truncating at page 1 would drop real findings and falsely
 *  resolve ledger rows that still exist upstream. */
function ghJsonAll<T>(endpoint: string): T[] {
  return ghJson<T[][]>(['api', '--paginate', '--slurp', endpoint]).flat();
}

// --- shared HTTP-source helpers (sonarcloud, codacy, codescene) ---------------

const CURL_TIMEOUT_MS = 30_000;

/** Trailing slashes, no regex — `/\/+$/` on uncontrolled input trips
 *  CodeQL's polynomial-regex rule; a backward scan is linear anyway. */
export function stripSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') {
    end--;
  }
  return s.slice(0, end);
}

/** A token may only cross the wire over https — or cleartext to loopback
 *  (self-hosted dev rigs). Any other scheme/host refuses the request. */
export function assertTokenSafeHost(host: string, source: string): URL {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new SourceSkipped(`${source} host "${host}" is not a valid URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:') {
    if (!loopback) {
      throw new SourceSkipped(
        `${source} host ${host} is plain http — the token would cross the wire cleartext; use https`
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new SourceSkipped(`${source} host "${host}" — only http(s) URLs can carry a token`);
  }
  return url;
}

/** curl transport shared by the HTTP API sources — the collectors are
 *  synchronous and no official CLIs exist. Credential headers ride a
 *  0600 file (`-H @file`) in a private tmpdir that lives only for the
 *  spawn — never argv, every local user can `ps`. `body` is sent via
 *  `-d` (filter JSON carries no secrets, argv is fine). */
export function curlJson(
  url: string,
  headers: string[],
  opts: { label: string; method?: 'POST'; body?: string }
): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'bro-curl-hdr-'));
  try {
    const hdr = join(dir, 'headers');
    writeFileSync(hdr, headers.map(h => `${h}\n`).join(''), { mode: 0o600 });
    const args = [
      '-sS',
      '--fail-with-body',
      '--max-time',
      String(Math.ceil(CURL_TIMEOUT_MS / 1000)),
      '-H',
      `@${hdr}`,
    ];
    if (opts.method === 'POST') {
      args.push('-X', 'POST');
    }
    if (opts.body !== undefined) {
      args.push('-d', opts.body);
    }
    args.push(url);
    const res = spawnSync(
      'curl', // NOSONAR — PATH lookup is the contract (curl like gh/glab/bd)
      args,
      { encoding: 'utf8', timeout: CURL_TIMEOUT_MS + 15_000, maxBuffer: 64 * 1024 * 1024 }
    );
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? `${opts.label}: curl not found — the sync transport needs curl on PATH`
          : `${opts.label}: curl failed — ${res.error.message}`
      );
    }
    if (res.status !== 0) {
      const detail = res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(0, 300);
      const reason = detail !== '' ? detail : `curl exited ${res.status}`;
      throw new Error(`${opts.label}: request failed — ${reason}`);
    }
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new Error(`${opts.label}: non-JSON response — ${res.stdout.slice(0, 200)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One record a PR-decorating source dropped plus the open row that
 *  covers it. */
export interface DedupeDupe {
  record: DebtRecord;
  coveredBy: string;
}

/** Review-thread dedupe shared by the sources whose services decorate
 *  PRs (specs: bro-huy5o.4 sonarcloud, bro-huy5o.5 codacy + codescene).
 *  A fresh record is dropped when an OPEN review-thread row — `source`
 *  absent or the PR sweep — covers it per the source's `covers`
 *  predicate. */
export function dedupeByThreads(
  records: DebtRecord[],
  existing: DebtRecord[],
  covers: (rec: DebtRecord, thread: DebtRecord) => boolean
): { kept: DebtRecord[]; duped: DedupeDupe[] } {
  const threads = existing.filter(
    r => r.status === 'open' && (r.source === undefined || r.source === 'review-threads')
  );
  const kept: DebtRecord[] = [];
  const duped: DedupeDupe[] = [];
  for (const rec of records) {
    const cover = threads.find(t => covers(rec, t));
    if (cover !== undefined) {
      duped.push({ record: rec, coveredBy: cover.thread_id });
    } else {
      kept.push(rec);
    }
  }
  return { kept, duped };
}

/** Sources whose findings a PR-decorating bot may have already landed
 *  via the review-threads sweep — dedupe before landing, then ride the
 *  shared duplicate/reopen overlay bookkeeping in the CLI. */
export const SOURCE_DEDUPES: Partial<
  Record<
    DebtSource,
    (records: DebtRecord[], existing: DebtRecord[]) => { kept: DebtRecord[]; duped: DedupeDupe[] }
  >
> = {
  sonarcloud: dedupeReviewThreads,
  codacy: dedupeCodacyThreads,
  codescene: dedupeCodesceneThreads,
};

export function baseRecord(
  ctx: CollectCtx,
  opts: {
    threadId: string;
    url: string;
    priority: DebtPriority;
    path: string;
    line?: number | null;
    author: string;
    body: string;
    createdAt: string;
    source: DebtSource;
  }
): DebtRecord {
  return {
    thread_id: opts.threadId,
    thread_url: opts.url,
    status: 'open',
    priority: opts.priority,
    needs: 'code_change',
    source_pr: 0,
    source_pr_url: '',
    source_pr_title: opts.source,
    merged_at: opts.createdAt,
    merged_sha: '',
    path: opts.path,
    line: opts.line ?? null,
    author: opts.author,
    body: opts.body,
    body_preview: bodyPreview(opts.body),
    fingerprint: fingerprint({ body: opts.body, path: opts.path }),
    area: deriveArea(opts.path),
    harvested_at: ctx.harvestedAt,
    harvest_run_id: ctx.runId,
    times_seen: 1,
    fix_pr: null,
    fixed_at: null,
    notes: null,
    source: opts.source,
  };
}

// --- sverka ------------------------------------------------------------------

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
}

interface SarifRun {
  tool?: { driver?: { name?: string } };
  results?: SarifResult[];
}

interface SarifLog {
  runs?: SarifRun[];
}

function sarifLevelToPriority(level?: string): DebtPriority {
  switch ((level ?? '').toLowerCase()) {
    case 'error':
      return 'blocking';
    case 'warning':
      return 'scan';
    case 'note':
    case 'none':
      return 'nit';
    default:
      return 'scan';
  }
}

/** `.sarif` files directly inside one directory — readdir failures
 *  propagate so the caller can fail the snapshot as incomplete. */
function sarifFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sarif'))
    .map(entry => join(dir, entry.name));
}

function findSarifFiles(root: string): { files: string[]; complete: boolean; reason?: string } {
  const candidates = [join(root, '.sverka', 'artifacts'), join(root, '.sverka', 'sarif')];
  const out: string[] = [];
  let sawDir = false;
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      sawDir = true;
      out.push(...sarifFilesIn(dir));
    } catch (err) {
      return {
        files: [],
        complete: false,
        reason: `cannot read SARIF directory ${dir} — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (!sawDir) {
    return {
      files: [],
      complete: false,
      reason:
        'no .sverka/artifacts or .sverka/sarif directory found — import a completed sverka run first (bro check --evaluate or copy *.sarif into .sverka/artifacts)',
    };
  }
  if (out.length === 0) {
    return {
      files: [],
      complete: false,
      reason:
        'no .sarif files found in .sverka/artifacts or .sverka/sarif — import a completed sverka run first',
    };
  }
  return { files: [...new Set(out)], complete: true };
}

export function collectSverka(ctx: CollectCtx): DebtRecord[] {
  const root = ctx.dir ?? process.cwd();
  const found = findSarifFiles(root);
  if (!found.complete) {
    throw new SourceSkipped(found.reason ?? 'incomplete sverka SARIF snapshot');
  }
  return found.files.flatMap(file => collectSarifFile(ctx, root, file));
}

/** One SARIF file → records. Anything unreadable or malformed throws
 *  SourceSkipped: a partial snapshot must never reach the resolve sweep
 *  looking like "all sverka findings fixed upstream". */
function collectSarifFile(ctx: CollectCtx, root: string, file: string): DebtRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new SourceSkipped(
      `failed reading SARIF ${file} — ${err instanceof Error ? err.message : String(err)}; refusing partial snapshot`
    );
  }
  const log = parseSarif(file, raw);
  const relFile = relative(root, file);
  return log.runs.flatMap(run => sarifRunRecords(ctx, run, relFile, root));
}

/** JSON.parse can yield null/primitives too — validate before touching
 *  `.runs` so a bad snapshot always lands as SourceSkipped, not TypeError. */
function parseSarif(file: string, raw: string): { runs: SarifRun[] } {
  let log: unknown;
  try {
    log = JSON.parse(raw);
  } catch (err) {
    throw new SourceSkipped(
      `invalid SARIF JSON in ${file} — ${err instanceof Error ? err.message : String(err)}; refusing partial snapshot`
    );
  }
  if (log === null || typeof log !== 'object' || !Array.isArray((log as SarifLog).runs)) {
    throw new SourceSkipped(`SARIF in ${file} has no runs array — refusing partial snapshot`);
  }
  return log as { runs: SarifRun[] };
}

/** SARIF artifact URIs are URIs, not repo paths — `file:///abs/x.ts` and
 *  percent-encoded `a%20b.ts` both land here. Normalize to a
 *  checkout-relative path so area labels and bead metadata see the real
 *  source path; a URI outside the root keeps its decoded filesystem path. */
function sarifUriToPath(uri: string, root: string): string {
  if (uri === '') return '';
  if (uri.startsWith('file://')) {
    try {
      const abs = fileURLToPath(uri);
      const rel = relative(root, abs);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
    } catch {
      return uri;
    }
  }
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri; // malformed percent-encoding — keep the raw reference
  }
}

function sarifRunRecords(
  ctx: CollectCtx,
  run: SarifRun,
  relFile: string,
  root: string
): DebtRecord[] {
  if (run === null || typeof run !== 'object') return [];
  const tool = run.tool?.driver?.name ?? 'sverka';
  // `results` may be absent (a clean run legitimately reports nothing) but a
  // present non-array value is malformed — silently dropping it would read
  // as "findings fixed upstream" to the resolve sweep.
  if (run.results !== undefined && !Array.isArray(run.results)) {
    throw new SourceSkipped(
      `SARIF run in ${relFile} has a non-array results value — refusing partial snapshot`
    );
  }
  const results = run.results ?? [];
  return results
    .map(res => sarifResultRecord(ctx, tool, res, relFile, root))
    .filter((r): r is DebtRecord => r !== null);
}

function sarifResultRecord(
  ctx: CollectCtx,
  tool: string,
  res: SarifResult,
  relFile: string,
  root: string
): DebtRecord | null {
  if (res === null || typeof res !== 'object') return null;
  const ruleId = typeof res.ruleId === 'string' ? res.ruleId : 'unknown';
  const loc = res.locations?.[0]?.physicalLocation;
  const uri = sarifUriToPath(loc?.artifactLocation?.uri ?? '', root);
  const line = typeof loc?.region?.startLine === 'number' ? loc.region.startLine : null;
  const msg =
    typeof res.message?.text === 'string' && res.message.text !== '' ? res.message.text : ruleId;
  // Stable identity: source + tool + rule + artifact location + source SARIF
  // file + message fingerprint. Segments are percent-encoded — `:` is legal
  // inside ruleIds/URIs and must never act as a field delimiter. relFile
  // scopes identity per artifact file so identical findings reported by two
  // different snapshots stay distinct rows instead of silently merging.
  // external_ref in beads = thread_id; ledger upserts by thread_id.
  const seg = (s: string): string => encodeURIComponent(s);
  const threadId = `sverka:${seg(tool)}:${seg(ruleId)}:${seg(uri)}:${line ?? 0}:${seg(relFile)}:${fingerprint({ body: msg, path: uri })}`;
  return baseRecord(ctx, {
    threadId,
    // No navigable URL exists for a local artifact — the machine-local path
    // would be a dead link everywhere else, so the field stays empty and the
    // repo-relative SARIF file rides in the body for provenance instead.
    url: '',
    priority: sarifLevelToPriority(res.level),
    path: uri,
    line,
    author: tool,
    body: `[${res.level ?? 'warning'}] ${ruleId}: ${msg} (${relFile})`,
    createdAt: ctx.harvestedAt,
    source: 'sverka',
  });
}

// --- dependabot -------------------------------------------------------------

interface DependabotAlert {
  number: number;
  html_url: string;
  created_at: string;
  dependency?: { manifest_path?: string };
  security_vulnerability?: {
    severity?: string;
    package?: { name?: string };
    summary?: string;
  };
}

/** Open dependabot PRs — an alert with a fix PR in flight isn't debt, the
 *  PR is the work item. Matched by head ref `dependabot/.../<pkg>-<ver>` —
 *  the trailing dash is the version boundary so `ember` can't match
 *  `ember-cli-1.0`. Dependabot refs drop the `@` from scoped packages.
 *  Failure propagates: an empty list here would mark every covered alert
 *  as debt, so the caller skips the whole source on error. */
function dependabotOpenPrs(
  repo: string
): Array<{ number: number; headRefName: string; url: string }> {
  return ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--author',
    'app/dependabot',
    '--state',
    'open',
    '--json',
    'number,headRefName,url',
    '--limit',
    '200',
  ]);
}

export function collectDependabot(ctx: CollectCtx): DebtRecord[] {
  const alerts = ghJsonAll<DependabotAlert>(
    `repos/${ctx.repo}/dependabot/alerts?state=open&per_page=100`
  );
  const prs = dependabotOpenPrs(ctx.repo);
  const out: DebtRecord[] = [];
  for (const a of alerts) {
    const pkg = a.security_vulnerability?.package?.name?.replace(/^@/, '') ?? '';
    const fixPr = pkg ? prs.find(p => p.headRefName.includes(`${pkg}-`)) : undefined;
    if (fixPr) continue; // linked PR is the work item — see bead bro-8gk
    const severity = a.security_vulnerability?.severity ?? 'medium';
    const body =
      a.security_vulnerability?.summary ??
      `Dependabot alert #${a.number} (${pkg || 'unknown package'}, ${severity})`;
    out.push(
      baseRecord(ctx, {
        threadId: `dependabot:${a.number}`,
        url: a.html_url,
        priority: severity === 'critical' || severity === 'high' ? 'blocking' : 'scan',
        path: a.dependency?.manifest_path ?? '',
        author: 'dependabot[bot]',
        body: `[${severity}] ${pkg}: ${body}`,
        createdAt: a.created_at,
        source: 'dependabot',
      })
    );
  }
  return out;
}

// --- code-scanning ----------------------------------------------------------

interface ScanAlert {
  number: number;
  html_url: string;
  created_at: string;
  rule?: { id?: string; description?: string; severity?: string };
  most_recent_instance?: { location?: { path?: string; start_line?: number } };
}

export function collectCodeScanning(ctx: CollectCtx): DebtRecord[] {
  const alerts = ghJsonAll<ScanAlert>(
    `repos/${ctx.repo}/code-scanning/alerts?state=open&per_page=100`
  );
  return alerts.map(a =>
    baseRecord(ctx, {
      threadId: `code-scanning:${a.number}`,
      url: a.html_url,
      priority: a.rule?.severity === 'error' ? 'blocking' : 'scan',
      path: a.most_recent_instance?.location?.path ?? '',
      author: 'github-code-scanning',
      body: `${a.rule?.id ?? 'unknown rule'}: ${a.rule?.description ?? 'code scanning alert'}`,
      createdAt: a.created_at,
      source: 'code-scanning',
    })
  );
}

// --- secret-scanning --------------------------------------------------------

interface SecretAlert {
  number: number;
  html_url: string;
  created_at: string;
  secret_type?: string;
  secret_type_display_name?: string;
}

export function collectSecretScanning(ctx: CollectCtx): DebtRecord[] {
  const alerts = ghJsonAll<SecretAlert>(
    `repos/${ctx.repo}/secret-scanning/alerts?state=open&per_page=100`
  );
  return alerts.map(a =>
    baseRecord(ctx, {
      threadId: `secret-scanning:${a.number}`,
      url: a.html_url,
      priority: 'blocking',
      path: '',
      author: 'github-secret-scanning',
      body: `Secret scanning alert: ${a.secret_type_display_name ?? a.secret_type ?? 'unknown type'}`,
      createdAt: a.created_at,
      source: 'secret-scanning',
    })
  );
}

// --- stale-prs --------------------------------------------------------------

interface OpenPr {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  author?: { login?: string };
  statusCheckRollup?: Array<{ conclusion?: string; status?: string }>;
}

/** Open PRs idle > staleDays or failing checks. Drafts are flagged only when
 *  they fail checks — a quiet WIP draft is work in progress, not debt. */
export function collectStalePrs(ctx: CollectCtx, staleDays: number): DebtRecord[] {
  const prs = ghJson<OpenPr[]>([
    'pr',
    'list',
    '--repo',
    ctx.repo,
    '--state',
    'open',
    '--json',
    'number,title,url,updatedAt,isDraft,author,statusCheckRollup',
    '--limit',
    '200',
  ]);
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const out: DebtRecord[] = [];
  for (const pr of prs) {
    const failing = (pr.statusCheckRollup ?? []).some(c => c.conclusion === 'FAILURE');
    const updated = Date.parse(pr.updatedAt);
    if (Number.isNaN(updated)) continue; // malformed timestamp — can't judge staleness
    const idleDays = Math.floor((Date.now() - updated) / 86_400_000);
    const stale = updated < cutoff;
    if (pr.isDraft && !failing) continue;
    if (!stale && !failing) continue;
    const reasons = [stale ? `idle ${idleDays}d` : null, failing ? 'failing checks' : null].filter(
      Boolean
    );
    out.push(
      baseRecord(ctx, {
        threadId: `stale-pr:${pr.number}`,
        url: pr.url,
        priority: failing ? 'blocking' : 'nit',
        path: '',
        author: pr.author?.login ?? 'unknown',
        body: `PR #${pr.number} "${pr.title}" — ${reasons.join(', ')}`,
        createdAt: pr.updatedAt,
        source: 'stale-prs',
      })
    );
  }
  return out;
}

// --- failed-ci ---------------------------------------------------------------

interface WorkflowRun {
  id: number;
  name?: string;
  html_url: string;
  conclusion?: string;
  created_at: string;
  head_branch?: string;
}

/** Latest completed run on the default branch — a single stable row
 *  (`failed-ci:<branch>`) instead of one row per failed run. */
export function collectFailedCi(ctx: CollectCtx): DebtRecord[] {
  const repoInfo = ghJson<{ default_branch?: string }>(['api', `repos/${ctx.repo}`]);
  const branch = repoInfo.default_branch ?? 'main';
  const res = ghJson<{ workflow_runs?: WorkflowRun[] }>([
    'api',
    `repos/${ctx.repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`,
  ]);
  const latest = res.workflow_runs?.[0];
  if (latest?.conclusion !== 'failure') return [];
  return [
    baseRecord(ctx, {
      threadId: `failed-ci:${branch}`,
      url: latest.html_url,
      priority: 'blocking',
      path: '',
      author: 'ci',
      body: `Default-branch CI failing: "${latest.name ?? 'workflow'}" on ${branch} (run ${latest.id})`,
      createdAt: latest.created_at,
      source: 'failed-ci',
    }),
  ];
}

export const COLLECTORS: Record<DebtSource, (ctx: CollectCtx, staleDays: number) => DebtRecord[]> =
  {
    dependabot: ctx => collectDependabot(ctx),
    'code-scanning': ctx => collectCodeScanning(ctx),
    'secret-scanning': ctx => collectSecretScanning(ctx),
    'stale-prs': (ctx, staleDays) => collectStalePrs(ctx, staleDays),
    'failed-ci': ctx => collectFailedCi(ctx),
    sonarcloud: ctx =>
      collectSonarcloud(ctx, { dir: ctx.dir, cfg: ctx.sourceConfig?.['sonarcloud'] }),
    codacy: ctx => collectCodacy(ctx, { cfg: ctx.sourceConfig?.['codacy'] }),
    codescene: ctx => collectCodescene(ctx, { cfg: ctx.sourceConfig?.['codescene'] }),
    sverka: ctx => collectSverka(ctx),
  };

/**
 * Alerts/CI are server-side truth: an open ledger row for a source whose
 * finding is absent from the fresh fetch resolved upstream — return its
 * thread_ids so collect can overlay them `done`.
 */
export function resolvedThreadIds(
  existing: DebtRecord[],
  source: DebtSource,
  fresh: DebtRecord[]
): string[] {
  const live = new Set(fresh.map(r => r.thread_id));
  return existing
    .filter(r => r.source === source && r.status === 'open' && !live.has(r.thread_id))
    .map(r => r.thread_id);
}
