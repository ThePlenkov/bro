/**
 * `bro skills` — facade over the skills CLI (npx skills) for
 * config-declared agent-skill dependencies.
 *
 * `skills.install` in bro.config declares the sources —
 * `github:<owner>/<repo>[/<path>]`, bare `<owner>/<repo>`, an `https://`
 * URL, or `local:<relpath>` — and `bro skills sync` materialises them
 * into `.agents/skills/` (the one in-repo plane ~22 agents read) plus
 * the per-agent links `skills.agents` selects. `skills-lock.json` —
 * committed, CLI-maintained — pins each vendored skill by source + ref
 * + computedHash; `.agents/skills/` itself stays gitignored
 * (spec: specs/bro-448ze.md).
 *
 *   bro skills sync [--root dir] [--json]
 *   bro skills list [--root dir] [--json]
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  checkSkillLock,
  hasHelpFlag,
  printUsage,
  readSkillLock,
  type ExitCode,
  type LockedSkill,
  type SkillDrift,
} from '@broject/core';
import { flag } from './args.ts';
import { skillsSection, type SkillsConfig } from './skills-config.ts';
import { loadBroConfig } from '../plugins.ts';

export { skillsSection, type SkillsConfig } from './skills-config.ts';

// --- source descriptors --------------------------------------------------------

export type SkillSource =
  | { kind: 'github'; repo: string; path?: string; skill?: string; raw: string }
  | { kind: 'url'; url: string; raw: string }
  | { kind: 'local'; path: string; raw: string }
  | { kind: 'invalid'; raw: string; reason: string };

/** `<owner>/<repo>` — the two leading path segments a github: source
 *  (or a bare shorthand) must carry. */
const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A `local:` path must stay inside the checkout — absolute paths and
 *  `..` segments would link outside content into `.agents/skills/`. */
function localPath(raw: string, spec: string, prefix: string): SkillSource {
  const path = spec.slice(prefix.length).trim();
  if (path === '') {
    return { kind: 'invalid', raw, reason: 'local: needs a repo-relative path' };
  }
  if (isAbsolute(path) || path.split('/').includes('..')) {
    return {
      kind: 'invalid',
      raw,
      reason: 'local: must be repo-relative — no absolute paths, no ..',
    };
  }
  return { kind: 'local', path, raw };
}

function parseLocalSource(raw: string, spec: string): SkillSource | null {
  if (spec.startsWith('local:')) {
    return localPath(raw, spec, 'local:');
  }
  return spec.startsWith('./') ? localPath(raw, spec, '') : null;
}

function parseGithubSource(raw: string, spec: string): SkillSource | null {
  if (!spec.startsWith('github:')) {
    return null;
  }
  const [owner, name, ...rest] = spec
    .slice('github:'.length)
    .split('/')
    .filter(s => s !== '');
  const repo = `${owner ?? ''}/${name ?? ''}`;
  if (!GH_REPO.test(repo) || [owner, name].some(s => s === undefined || s === '.' || s === '..')) {
    return { kind: 'invalid', raw, reason: 'github: needs <owner>/<repo>[/<path>]' };
  }
  if (rest.length === 0) {
    return { kind: 'github', repo, raw };
  }
  const path = rest.join('/');
  return { kind: 'github', repo, path, skill: basename(path), raw };
}

/** One `skills.install` entry → a typed source. Anything outside the
 *  grammar is `invalid` — reported by the command, never skipped. */
export function parseSkillSource(raw: unknown): SkillSource {
  if (typeof raw !== 'string') {
    return {
      kind: 'invalid',
      raw: JSON.stringify(raw) ?? '?',
      reason: 'skills.install entries must be strings (the section a string array)',
    };
  }
  const spec = raw.trim();
  const local = parseLocalSource(raw, spec);
  if (local !== null) {
    return local;
  }
  const github = parseGithubSource(raw, spec);
  if (github !== null) {
    return github;
  }
  if (spec.startsWith('http://')) {
    return { kind: 'invalid', raw, reason: 'plaintext http:// is not a source — use https://' };
  }
  if (spec.startsWith('https://')) {
    return { kind: 'url', url: spec, raw };
  }
  if (GH_REPO.test(spec) && !spec.split('/').some(s => s === '.' || s === '..')) {
    return { kind: 'github', repo: spec, raw };
  }
  return {
    kind: 'invalid',
    raw,
    reason:
      'expected github:<owner>/<repo>[/<path>], <owner>/<repo>, an https:// URL, or local:<path>',
  };
}

// --- skills CLI ---------------------------------------------------------------

/** A spawn target — `[file, ...prefixArgs]`: a resolved `skills` bin
 *  runs directly; the default is `npx -y skills`. */
export interface SkillsBin {
  file: string;
  args: string[];
  via?: string;
}

export type SpawnRunner = (
  bin: SkillsBin,
  root: string,
  args: string[]
) => SpawnSyncReturns<string>;

/** One argv element quoted for `cmd.exe /d /s /c` — every metachar
 *  caret-escaped so a configured path or source string can never turn
 *  into a second command. */
function cmdQuote(arg: string): string {
  return `"${arg.replace(/[%^&|<>()"]/g, '^$&')}"`;
}

/** Windows can't exec `.cmd`/`.bat` (npx's own shim!) or a bare PATH
 *  command without the interpreter — route through ComSpec with every
 *  argument quoted; POSIX spawns stay direct. */
function spawnTarget(file: string, args: string[]): { file: string; args: string[] } {
  const needsCmd =
    /\.(cmd|bat)$/i.test(file) ||
    (process.platform === 'win32' && !/\.(exe|com)$/i.test(file) && !file.includes('/'));
  if (process.platform !== 'win32' || !needsCmd) {
    return { file, args };
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', cmdQuote(file), ...args.map(cmdQuote)],
  };
}

function spawnArgv(file: string, args: string[], cwd?: string): SpawnSyncReturns<string> {
  const t = spawnTarget(file, args);
  return spawnSync(t.file, t.args, {
    // NOSONAR — npx/PATH lookup is the contract (gh/bd precedent)
    cwd,
    stdio: cwd === undefined ? 'pipe' : undefined,
    encoding: 'utf8',
    // the CLI's interactive UI is verbose — headroom; -y skips prompts
    maxBuffer: 64 * 1024 * 1024,
    // a restore re-clones every locked repo — bounded, never infinite
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** A bare command on PATH? The probe is `cmd --version` — present and
 *  runnable wins; spawn errors and non-zero exits read as absent. */
export function commandOnPath(cmd: string): boolean {
  const proc = spawnArgv(cmd, ['--version']);
  return proc.error === undefined && proc.status === 0;
}

type BinProbe = (cmd: string) => boolean;

/** Resolution: `skills.bin` (a path with a separator, else a PATH
 *  command) → `skills` on PATH → `npx -y skills`. The npx fallback needs
 *  no probe — npx is the documented invocation and resolves the package
 *  on demand. `probe` is injectable so tests never touch the real PATH. */
export function resolveSkillsBin(
  root: string,
  cfgBin?: string,
  probe: BinProbe = commandOnPath
): SkillsBin {
  if (cfgBin !== undefined) {
    if (cfgBin.includes('/') || cfgBin.includes(sep)) {
      const p = isAbsolute(cfgBin) ? cfgBin : resolve(root, cfgBin);
      return { file: p, args: [], via: 'config' };
    }
    return { file: cfgBin, args: [], via: 'config' };
  }
  if (probe('skills')) {
    return { file: 'skills', args: [], via: 'path' };
  }
  return { file: 'npx', args: ['-y', SKILLS_PKG], via: 'npx' };
}

/** The npx fallback package — pinned (a bare `skills` spec would
 *  execute whatever the registry serves that day); skills.bin or a
 *  PATH install overrides it. */
const SKILLS_PKG = 'skills@1.7.4';

const spawnSkills: SpawnRunner = (bin, root, args) =>
  spawnArgv(bin.file, [...bin.args, ...args], root);

function addArgs(src: SkillSource & { kind: 'github' | 'url' }, agents: string[]): string[] {
  const pkg = src.kind === 'url' ? src.url : src.repo;
  const args = ['add', pkg];
  if (src.kind === 'github' && src.skill !== undefined) {
    args.push('-s', src.skill);
  }
  for (const a of agents) {
    args.push('-a', a);
  }
  args.push('-y');
  return args;
}

/** The skills CLI's own verdict for a spawn — the process ran and
 *  reported a status (spawn errors surface as `error`, not status). */
function spawnFailed(proc: SpawnSyncReturns<string>): boolean {
  return proc.error !== undefined || (proc.status ?? 1) !== 0;
}

function spawnDetail(proc: SpawnSyncReturns<string>): string {
  const tail = (proc.stderr ?? proc.stdout ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-2)
    .join(' — ');
  return proc.error?.message ?? (tail !== '' ? tail : `exit ${proc.status}`);
}

// --- local links ---------------------------------------------------------------

/** A name safe to be a `.agents/skills/` entry — no separators, no
 *  `..`, so frontmatter can't aim the link outside the skills dir. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A local skill's name — SKILL.md frontmatter `name:` when it's a
 *  safe directory name, basename fallback. */
export function localSkillName(root: string, rel: string): string {
  const dir = resolve(root, rel);
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const m = md.match(/^name:\s*["']?([^\s"']+)["']?\s*$/m);
    if (m?.[1] !== undefined && SAFE_NAME.test(m[1])) {
      return m[1];
    }
  } catch {
    // no readable SKILL.md — the caller reports the basename anyway
  }
  return basename(dir);
}

export interface LocalLink {
  name: string;
  state: 'linked' | 'present' | 'error';
  detail?: string;
}

/** `.agents/skills/<name> → <relpath>` — create via a temp-name rename
 *  (no delete-then-create gap), verify an existing link's target, and
 *  never overwrite: a real dir or a link pointing elsewhere is an
 *  error, not a repoint — bro owns links, never deletes content. */
export function ensureLocalLink(root: string, rel: string): LocalLink {
  const dir = resolve(root, rel);
  const skillsDir = join(root, '.agents', 'skills');
  const name = localSkillName(root, rel);
  if (!existsSync(join(dir, 'SKILL.md'))) {
    return { name, state: 'error', detail: `no SKILL.md at ${rel}` };
  }
  mkdirSync(skillsDir, { recursive: true });
  const link = join(skillsDir, name);
  const target = relative(skillsDir, dir);
  try {
    let st: Stats | null;
    try {
      st = lstatSync(link);
    } catch {
      st = null;
    }
    if (st === null) {
      const tmp = `${link}.bro-${process.pid}`;
      symlinkSync(target, tmp);
      renameSync(tmp, link);
      return { name, state: 'linked' };
    }
    if (!st.isSymbolicLink()) {
      return {
        name,
        state: 'present',
        detail: `.agents/skills/${name} is not a symlink — left alone`,
      };
    }
    if (resolve(skillsDir, readlinkSync(link)) === dir) {
      return { name, state: 'linked', detail: 'unchanged' };
    }
    return {
      name,
      state: 'error',
      detail: `.agents/skills/${name} already links elsewhere — not repointing`,
    };
  } catch (err) {
    return {
      name,
      state: 'error',
      detail: `link failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// --- reconcile -----------------------------------------------------------------

export interface SkillRow {
  name: string;
  source: string;
  state: 'ok' | 'linked' | 'present' | 'missing' | 'drifted' | 'extra' | 'pending' | 'error';
  detail?: string;
}

const skillsDirOf = (root: string): string => join(root, '.agents', 'skills');

/** `https://github.com/<owner>/<repo>[/tree/<ref>/<path…>]` — the repo a
 *  URL source records in the lock, plus the one skill a `/tree/` URL
 *  names (the CLI accepts tree URLs; the lock's `source` is the repo). */
function urlRepo(url: string): { repo: string; skill?: string } | null {
  const m = url.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/|$)/);
  if (m?.[1] === undefined) {
    return null;
  }
  const repo = m[1].replace(/\.git$/, '');
  const segs = url.split('/').filter(s => s !== '');
  const treeAt = segs.indexOf('tree');
  const skill = treeAt >= 0 && segs.length > treeAt + 2 ? segs[segs.length - 1] : undefined;
  return skill !== undefined ? { repo, skill } : { repo };
}

/** A source string compared for equality — scheme, `git@` form, `.git`
 *  suffix and trailing slash normalized away so `https://host/o/r` and
 *  `git@host:o/r.git` name the same thing. */
function normSource(s: string): string {
  return s
    .replace(/^https?:\/\//, '')
    .replace(/^git@([^:/]+)[:/]/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** Which lock entries a github/URL source is expected to cover —
 *  a pinned path names one skill; a bare repo/URL is covered by the
 *  entries it recorded (`source` matches, normalized, on any host). */
function lockNamesFor(src: SkillSource, locked: Map<string, LockedSkill>): string[] {
  if (src.kind === 'github' && src.skill !== undefined) {
    return [src.skill];
  }
  if (src.kind === 'url') {
    const u = urlRepo(src.url);
    if (u?.skill !== undefined) {
      return [u.skill];
    }
    const want = u?.repo ?? normSource(src.url);
    return [...locked.values()].filter(e => normSource(e.source) === want).map(e => e.name);
  }
  if (src.kind === 'github') {
    return [...locked.values()].filter(e => e.source === src.repo).map(e => e.name);
  }
  return [];
}

/** `.agents/skills/<name>/SKILL.md` exists. */
function installed(root: string, name: string): boolean {
  return existsSync(join(skillsDirOf(root), name, 'SKILL.md'));
}

/** Lock entries and on-disk skill dirs not covered by any declared
 *  source — reported, never removed. */
function extraNames(
  root: string,
  declared: SkillSource[],
  locked: Map<string, LockedSkill>
): string[] {
  const covered = new Set<string>();
  for (const src of declared) {
    for (const n of lockNamesFor(src, locked)) {
      covered.add(n);
    }
    if (src.kind === 'local') {
      covered.add(localSkillName(root, src.path));
    }
  }
  const extras = new Set<string>();
  for (const name of locked.keys()) {
    if (!covered.has(name)) {
      extras.add(name);
    }
  }
  try {
    for (const entry of readdirSync(skillsDirOf(root), { withFileTypes: true })) {
      if (!covered.has(entry.name)) {
        extras.add(entry.name);
      }
    }
  } catch {
    // no .agents/skills dir — nothing on disk to report
  }
  return [...extras].sort();
}

interface ReconcileCtx {
  root: string;
  locked: Map<string, LockedSkill>;
  driftByName: Map<string, SkillDrift>;
}

/** A locked skill's verdict: drift wins, else installed-or-locked is
 *  ok, else missing. */
function lockedState(ctx: ReconcileCtx, name: string): SkillRow['state'] {
  const d = ctx.driftByName.get(name);
  if (d !== undefined) {
    return d.kind;
  }
  return installed(ctx.root, name) || ctx.locked.has(name) ? 'ok' : 'missing';
}

/** `.agents/skills/<name>` — missing | linked | present (a real dir in
 *  the symlink's place) | error (a link that dangles or points at a
 *  different directory than the config names). */
function localRow(root: string, src: SkillSource & { kind: 'local' }): SkillRow {
  const name = localSkillName(root, src.path);
  const link = join(skillsDirOf(root), name);
  const want = resolve(root, src.path);
  let lst: Stats | null;
  try {
    lst = lstatSync(link);
  } catch {
    lst = null;
  }
  if (lst === null) {
    return { name, source: src.raw, state: 'missing' };
  }
  if (!lst.isSymbolicLink()) {
    return {
      name,
      source: src.raw,
      state: 'present',
      detail: 'a real dir, not the expected symlink',
    };
  }
  if (resolve(skillsDirOf(root), readlinkSync(link)) !== want) {
    return { name, source: src.raw, state: 'error', detail: 'link points elsewhere' };
  }
  return { name, source: src.raw, state: 'linked' };
}

/** Rows for one github/URL source — pending while the lock records
 *  nothing it covers. */
function remoteRows(src: SkillSource, ctx: ReconcileCtx): SkillRow[] {
  const names = lockNamesFor(src, ctx.locked);
  if (names.length === 0) {
    return [
      {
        name: src.kind === 'github' ? src.repo : src.kind === 'url' ? src.url : src.raw,
        source: src.raw,
        state: 'pending',
        detail: 'declared — nothing locked yet (bro skills sync installs)',
      },
    ];
  }
  return names.map(name => ({ name, source: src.raw, state: lockedState(ctx, name) }));
}

/** One declared source → its rows. */
function rowsForSource(src: SkillSource, ctx: ReconcileCtx): SkillRow[] {
  if (src.kind === 'invalid') {
    return [{ name: src.raw, source: '', state: 'error', detail: src.reason }];
  }
  if (src.kind === 'local') {
    return [localRow(ctx.root, src)];
  }
  return remoteRows(src, ctx);
}

/** The read-only reconcile — one row per declared source plus `extra`
 *  rows for lock/disk entries nothing declared. `drift` is the
 *  checkSkillLock verdict over the whole lock. */
export function collectRows(
  root: string,
  cfg: SkillsConfig
): { rows: SkillRow[]; drift: SkillDrift[] } {
  const locked = readSkillLock(root);
  const drift = checkSkillLock(locked, { skillsDir: skillsDirOf(root) });
  const ctx: ReconcileCtx = { root, locked, driftByName: new Map(drift.map(d => [d.name, d])) };
  const declared = cfg.install.map(parseSkillSource);
  const rows = declared.flatMap(src => rowsForSource(src, ctx));
  for (const name of extraNames(root, declared, locked)) {
    const d = ctx.driftByName.get(name);
    rows.push({
      name,
      source: locked.get(name)?.source ?? '',
      state: 'extra',
      ...(d !== undefined ? { detail: d.kind } : {}),
    });
  }
  return { rows, drift };
}

// --- sync -----------------------------------------------------------------------

export interface SyncStep {
  label: string;
  state: 'ok' | 'error' | 'skipped';
  detail?: string;
}

interface SyncCtx {
  root: string;
  cfg: SkillsConfig;
  bin: SkillsBin;
  spawn: SpawnRunner;
}

/** A path-pinned github source whose skill the lock already records
 *  from that repo at that path is skipped — a clone for zero
 *  information is quota burn, not correctness. A same-name skill
 *  locked from a different source or path is NOT satisfied. */
function alreadyLocked(src: SkillSource, locked: Map<string, LockedSkill>): boolean {
  if (src.kind !== 'github' || src.skill === undefined) {
    return false;
  }
  const e = locked.get(src.skill);
  if (e === undefined || e.source !== src.repo) {
    return false;
  }
  return src.path === undefined || dirname(e.skillPath) === src.path;
}

/** `skills add` for one github/URL source. */
function syncRemote(src: SkillSource & { kind: 'github' | 'url' }, ctx: SyncCtx): SyncStep {
  const label = src.kind === 'github' ? `github:${src.repo}` : src.url;
  if (src.kind === 'github' && alreadyLocked(src, readSkillLock(ctx.root))) {
    return { label, state: 'skipped', detail: `${src.skill} already locked` };
  }
  const proc = ctx.spawn(ctx.bin, ctx.root, addArgs(src, ctx.cfg.agents));
  return spawnFailed(proc)
    ? { label, state: 'error', detail: `skills add failed — ${spawnDetail(proc)}` }
    : { label, state: 'ok' };
}

/** `.agents/skills/` gaps vs the lock → one experimental_install. */
function syncRestore(ctx: SyncCtx): SyncStep | null {
  const missing = [...readSkillLock(ctx.root).keys()].filter(n => !installed(ctx.root, n));
  if (missing.length === 0) {
    return null;
  }
  const proc = ctx.spawn(ctx.bin, ctx.root, ['experimental_install', '-y']);
  return spawnFailed(proc)
    ? {
        label: 'experimental_install',
        state: 'error',
        detail: `restore of ${missing.length} missing skill(s) failed — ${spawnDetail(proc)}`,
      }
    : { label: 'experimental_install', state: 'ok', detail: `restored ${missing.length}` };
}

/** One declared source → its sync step. */
function syncDeclared(src: SkillSource, ctx: SyncCtx): SyncStep {
  if (src.kind === 'invalid') {
    return { label: src.raw, state: 'error', detail: src.reason };
  }
  if (src.kind === 'local') {
    const link = ensureLocalLink(ctx.root, src.path);
    return {
      label: `local:${src.path}`,
      state: link.state === 'error' ? 'error' : 'ok',
      ...(link.detail !== undefined
        ? { detail: `${link.name} — ${link.detail}` }
        : { detail: link.name }),
    };
  }
  return syncRemote(src, ctx);
}

/** Post-sync rows that mean the declared set did not land — a step can
 *  report ok yet leave the skill absent, blocked, or unrecorded. */
function rowsFailed(rows: SkillRow[]): boolean {
  return rows.some(
    r =>
      r.state === 'missing' ||
      r.state === 'error' ||
      r.state === 'drifted' ||
      r.state === 'pending' ||
      r.state === 'present'
  );
}

/** One sync at a time per checkout — concurrent runs race the
 *  CLI-maintained lockfile and the `.agents/skills` dir. A pid file
 *  held via O_EXCL; a dead holder's file is stale and retaken. */
function withSyncLock<T>(root: string, run: () => T): T | { lockError: string } {
  mkdirSync(skillsDirOf(root), { recursive: true });
  const lockPath = join(skillsDirOf(root), '.sync.lock');
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    try {
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      process.kill(pid, 0);
      return { lockError: `another bro skills sync holds the lock (pid ${pid})` };
    } catch {
      unlinkSync(lockPath); // stale — holder is gone
      fd = openSync(lockPath, 'wx');
    }
  }
  try {
    return run();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // a retaker already replaced it
    }
  }
}

export function runSync(
  root: string,
  cfg: SkillsConfig,
  spawn: SpawnRunner = spawnSkills,
  probe: BinProbe = commandOnPath
): { steps: SyncStep[]; rows: SkillRow[]; drift: SkillDrift[]; failed: boolean } {
  const ctx: SyncCtx = { root, cfg, bin: resolveSkillsBin(root, cfg.bin, probe), spawn };
  const out = withSyncLock(root, () => {
    const steps = cfg.install.map(parseSkillSource).map(src => syncDeclared(src, ctx));
    // the lock is CLI-maintained — re-read after the adds (setup --lock's
    // stale-lock lesson), then fill any .agents/skills gap it carries
    const restore = syncRestore(ctx);
    if (restore !== null) {
      steps.push(restore);
    }
    return steps;
  });
  if ('lockError' in out) {
    const { rows, drift } = collectRows(root, cfg);
    return {
      steps: [{ label: 'sync', state: 'error', detail: out.lockError }],
      rows,
      drift,
      failed: true,
    };
  }
  const steps = out;
  const { rows, drift } = collectRows(root, cfg);
  const failed = steps.some(s => s.state === 'error') || drift.length > 0 || rowsFailed(rows);
  return { steps, rows, drift, failed };
}

// --- render -----------------------------------------------------------------------

const ROW_ICON: Record<SkillRow['state'], string> = {
  ok: '✓',
  linked: '✓',
  present: '!',
  missing: '✗',
  drifted: '✗',
  extra: '·',
  pending: '○',
  error: '✗',
};

function renderRows(rows: SkillRow[]): string[] {
  return rows.map(r => {
    const src = r.source !== '' ? `  ${r.source}` : '';
    const detail = r.detail !== undefined ? ` — ${r.detail}` : '';
    const state = r.state === 'extra' ? 'extra (undeclared)' : r.state;
    return `${ROW_ICON[r.state]} ${r.name}${src}  ${state}${detail}`;
  });
}

function renderSteps(steps: SyncStep[]): string[] {
  const icon: Record<SyncStep['state'], string> = { ok: '✓', error: '✗', skipped: '-' };
  return steps.map(
    s => `${icon[s.state]} ${s.label}${s.detail !== undefined ? ` — ${s.detail}` : ''}`
  );
}

// --- command ------------------------------------------------------------------------

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro skills <command> [options]

Materialise config-declared agent-skill deps into .agents/skills/.

Commands:
  sync    install the skills.install sources — npx skills add per
          github/URL source, a bro-managed symlink per local: dir,
          experimental_install for lock gaps, then verify the lock
  list    the declared ↔ locked ↔ installed reconcile, read-only

Options:
  --root <dir>   run root (default: cwd)
  --json         machine-readable output
  --help         this text

Config (bro.config.json "skills"):
  install  source strings — github:<owner>/<repo>[/<path>],
           <owner>/<repo>, https://…, or local:<relpath>
  agents   'skills add -a' link targets (default: universal —
           the .agents/skills plane only)
  bin      explicit skills CLI (path or command)`,
    exitCode
  );
}

const BOOL_FLAGS = new Set(['--json', '--help', '-h']);

/** Stray args after the sub — `--root` consumes its value; anything
 *  else that isn't a known bool flag is a usage error. */
function rejectStrays(rest: string[]): void {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a === '--root') {
      i += 1;
      continue;
    }
    if (a.startsWith('--root=') || (a.startsWith('-') && BOOL_FLAGS.has(a))) {
      continue;
    }
    console.error(
      `error: unexpected ${a.startsWith('-') ? 'option' : 'argument'} ${JSON.stringify(a)} — see \`bro skills --help\``
    );
    process.exit(2);
  }
}

function parseSkillsArgs(argv: string[]): { sub: string; root: string; json: boolean } {
  const sub = argv[0];
  if (sub !== 'sync' && sub !== 'list') {
    usage(2);
  }
  const rest = argv.slice(1);
  rejectStrays(rest);
  return {
    sub,
    root: resolve(flag(rest, '--root') ?? process.cwd()),
    json: rest.includes('--json'),
  };
}

function cmdSync(root: string, cfg: SkillsConfig, json: boolean): void {
  const { steps, rows, drift, failed } = runSync(root, cfg);
  if (json) {
    console.log(
      JSON.stringify({
        command: 'skills sync',
        data: { steps, rows, drift: drift.map(d => ({ name: d.name, kind: d.kind })) },
      })
    );
  } else {
    for (const line of renderSteps(steps)) {
      console.log(line);
    }
    for (const d of drift) {
      console.log(`✗ ${d.name} — ${d.kind}${d.kind === 'drifted' ? ' (content ≠ lock)' : ''}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

function cmdList(root: string, cfg: SkillsConfig, json: boolean): void {
  const { rows } = collectRows(root, cfg);
  if (json) {
    console.log(JSON.stringify({ command: 'skills list', data: { rows } }));
  } else {
    for (const line of renderRows(rows)) {
      console.log(line);
    }
  }
  process.exitCode = 0;
}

export function runSkillsCommand(argv: string[]): void {
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const { sub, root, json } = parseSkillsArgs(argv);
  const cfg = (loadBroConfig(root).skills ?? skillsSection(undefined)) as SkillsConfig;
  if (sub === 'sync') {
    cmdSync(root, cfg, json);
  } else {
    cmdList(root, cfg, json);
  }
}
