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
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  | { kind: 'github'; repo: string; skill?: string; raw: string }
  | { kind: 'url'; url: string; raw: string }
  | { kind: 'local'; path: string; raw: string }
  | { kind: 'invalid'; raw: string; reason: string };

/** `<owner>/<repo>` — the two leading path segments a github: source
 *  (or a bare shorthand) must carry. */
const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** One `skills.install` string → a typed source. Anything outside the
 *  grammar is `invalid` — reported by the command, never skipped. */
export function parseSkillSource(raw: string): SkillSource {
  const spec = raw.trim();
  if (spec.startsWith('local:')) {
    const path = spec.slice('local:'.length).trim();
    return path === ''
      ? { kind: 'invalid', raw, reason: 'local: needs a repo-relative path' }
      : { kind: 'local', path, raw };
  }
  if (spec.startsWith('./')) {
    return { kind: 'local', path: spec, raw };
  }
  if (spec.startsWith('github:')) {
    const segs = spec
      .slice('github:'.length)
      .split('/')
      .filter(s => s !== '');
    const repo = segs.slice(0, 2).join('/');
    if (segs.length < 2 || !GH_REPO.test(repo)) {
      return { kind: 'invalid', raw, reason: 'github: needs <owner>/<repo>[/<path>]' };
    }
    const base = { kind: 'github' as const, repo, raw };
    return segs.length > 2 ? { ...base, skill: segs[segs.length - 1]! } : base;
  }
  if (spec.startsWith('https://') || spec.startsWith('http://')) {
    return { kind: 'url', url: spec, raw };
  }
  if (GH_REPO.test(spec)) {
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

/** Resolution: `skills.bin` (a path with a separator, else a PATH
 *  command) → `npx -y skills`. The npx fallback needs no probe — npx is
 *  the documented invocation and resolves the package on demand. */
export function resolveSkillsBin(root: string, cfgBin?: string): SkillsBin {
  if (cfgBin !== undefined) {
    if (cfgBin.includes('/') || cfgBin.includes(sep)) {
      const p = isAbsolute(cfgBin) ? cfgBin : resolve(root, cfgBin);
      return { file: p, args: [], via: 'config' };
    }
    return { file: cfgBin, args: [], via: 'config' };
  }
  return { file: 'npx', args: ['-y', 'skills'], via: 'npx' };
}

export type SpawnRunner = (
  bin: SkillsBin,
  root: string,
  args: string[]
) => SpawnSyncReturns<string>;

/** `.cmd`/`.bat` bins can't be spawned directly — route through the
 *  command interpreter (check.ts precedent). */
function spawnTarget(bin: SkillsBin): { file: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(bin.file)) {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', bin.file, ...bin.args],
    };
  }
  return bin;
}

const spawnSkills: SpawnRunner = (bin, root, args) => {
  const target = spawnTarget(bin);
  return spawnSync(target.file, [...target.args, ...args], {
    // NOSONAR — npx/PATH lookup is the contract (gh/bd precedent)
    cwd: root,
    encoding: 'utf8',
    // the CLI's interactive UI is verbose — headroom; -y skips prompts
    maxBuffer: 64 * 1024 * 1024,
    // a restore re-clones every locked repo — bounded, never infinite
    timeout: 300_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
};

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

/** A local skill's name — SKILL.md frontmatter `name:`, basename
 *  fallback. */
export function localSkillName(root: string, rel: string): string {
  const dir = resolve(root, rel);
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const m = md.match(/^name:\s*["']?([^\s"']+)["']?\s*$/m);
    if (m?.[1] !== undefined) {
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

/** `.agents/skills/<name> → <relpath>` — create or repoint. A real
 *  directory in the way is left alone and reported (`present`) — bro
 *  owns links, never deletes vendored content. */
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
  let st: Stats | null;
  try {
    st = lstatSync(link);
  } catch {
    st = null;
  }
  if (st === null) {
    symlinkSync(target, link);
    return { name, state: 'linked' };
  }
  if (!st.isSymbolicLink()) {
    return {
      name,
      state: 'present',
      detail: `.agents/skills/${name} is not a symlink — left alone`,
    };
  }
  if (readlinkSync(link) === target) {
    return { name, state: 'linked', detail: 'unchanged' };
  }
  unlinkSync(link);
  symlinkSync(target, link);
  return { name, state: 'linked', detail: 'repointed' };
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

/** Which lock entries a github/URL source is expected to cover —
 *  a pinned path names one skill; a bare repo/URL is covered by the
 *  entries it recorded (`source` matches the repo). */
function lockNamesFor(src: SkillSource, locked: Map<string, LockedSkill>): string[] {
  if (src.kind === 'github' && src.skill !== undefined) {
    return [src.skill];
  }
  if (src.kind === 'url') {
    const u = urlRepo(src.url);
    if (u === null) {
      return [];
    }
    if (u.skill !== undefined) {
      return [u.skill];
    }
    return [...locked.values()].filter(e => e.source === u.repo).map(e => e.name);
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

/** The read-only reconcile — one row per declared source plus `extra`
 *  rows for lock/disk entries nothing declared. `drift` is the
 *  checkSkillLock verdict over the whole lock. */
export function collectRows(
  root: string,
  cfg: SkillsConfig
): { rows: SkillRow[]; drift: SkillDrift[] } {
  const locked = readSkillLock(root);
  const drift = checkSkillLock(locked, { skillsDir: skillsDirOf(root) });
  const driftByName = new Map(drift.map(d => [d.name, d]));
  const declared = cfg.install.map(parseSkillSource);
  const rows: SkillRow[] = [];
  const lockedState = (name: string): SkillRow['state'] => {
    const d = driftByName.get(name);
    if (d !== undefined) {
      return d.kind;
    }
    return installed(root, name) || locked.has(name) ? 'ok' : 'missing';
  };
  for (const src of declared) {
    if (src.kind === 'invalid') {
      rows.push({ name: src.raw, source: '', state: 'error', detail: src.reason });
      continue;
    }
    if (src.kind === 'local') {
      const name = localSkillName(root, src.path);
      const link = join(skillsDirOf(root), name);
      let lst: Stats | null;
      try {
        lst = lstatSync(link);
      } catch {
        lst = null;
      }
      const state = lst === null ? 'missing' : lst.isSymbolicLink() ? 'linked' : 'present';
      rows.push({
        name,
        source: src.raw,
        state,
        ...(state === 'present' ? { detail: 'a real dir, not the expected symlink' } : {}),
      });
      continue;
    }
    const names = lockNamesFor(src, locked);
    if (names.length === 0) {
      rows.push({
        name: src.kind === 'github' ? src.repo : src.url,
        source: src.raw,
        state: 'pending',
        detail: 'declared — nothing locked yet (bro skills sync installs)',
      });
      continue;
    }
    for (const name of names) {
      rows.push({ name, source: src.raw, state: lockedState(name) });
    }
  }
  for (const name of extraNames(root, declared, locked)) {
    const d = driftByName.get(name);
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

/** `skills add` for one github/URL source. A path-pinned github source
 *  whose skill the lock already records is skipped — a clone for zero
 *  information is quota burn, not correctness. */
function syncRemote(
  src: SkillSource & { kind: 'github' | 'url' },
  root: string,
  cfg: SkillsConfig,
  bin: SkillsBin,
  locked: Map<string, LockedSkill>,
  spawn: SpawnRunner
): SyncStep {
  const label = src.kind === 'github' ? `github:${src.repo}` : src.url;
  if (
    src.kind === 'github' &&
    src.skill !== undefined &&
    locked.get(src.skill)?.source === src.repo
  ) {
    return { label, state: 'skipped', detail: `${src.skill} already locked` };
  }
  const proc = spawn(bin, root, addArgs(src, cfg.agents));
  return spawnFailed(proc)
    ? { label, state: 'error', detail: `skills add failed — ${spawnDetail(proc)}` }
    : { label, state: 'ok' };
}

/** `.agents/skills/` gaps vs the lock → one experimental_install. */
function syncRestore(
  root: string,
  bin: SkillsBin,
  locked: Map<string, LockedSkill>,
  spawn: SpawnRunner
): SyncStep | null {
  const missing = [...locked.keys()].filter(n => !installed(root, n));
  if (missing.length === 0) {
    return null;
  }
  const proc = spawn(bin, root, ['experimental_install', '-y']);
  return spawnFailed(proc)
    ? {
        label: 'experimental_install',
        state: 'error',
        detail: `restore of ${missing.length} missing skill(s) failed — ${spawnDetail(proc)}`,
      }
    : { label: 'experimental_install', state: 'ok', detail: `restored ${missing.length}` };
}

export function runSync(
  root: string,
  cfg: SkillsConfig,
  spawn: SpawnRunner = spawnSkills
): { steps: SyncStep[]; rows: SkillRow[]; drift: SkillDrift[]; failed: boolean } {
  const bin = resolveSkillsBin(root, cfg.bin);
  const declared = cfg.install.map(parseSkillSource);
  const steps: SyncStep[] = [];
  let failed = false;
  for (const src of declared) {
    if (src.kind === 'invalid') {
      steps.push({ label: src.raw, state: 'error', detail: src.reason });
      failed = true;
      continue;
    }
    if (src.kind === 'local') {
      const link = ensureLocalLink(root, src.path);
      steps.push({
        label: `local:${src.path}`,
        state: link.state === 'error' ? 'error' : 'ok',
        ...(link.detail !== undefined
          ? { detail: `${link.name} — ${link.detail}` }
          : { detail: link.name }),
      });
      if (link.state === 'error') {
        failed = true;
      }
      continue;
    }
    const step = syncRemote(src, root, cfg, bin, readSkillLock(root), spawn);
    steps.push(step);
    if (step.state === 'error') {
      failed = true;
    }
  }
  // the lock is CLI-maintained — re-read after the adds (setup --lock's
  // stale-lock lesson), then fill any .agents/skills gap it carries
  const restore = syncRestore(root, bin, readSkillLock(root), spawn);
  if (restore !== null) {
    steps.push(restore);
    if (restore.state === 'error') {
      failed = true;
    }
  }
  const { rows, drift } = collectRows(root, cfg);
  return { steps, rows, drift, failed: failed || drift.length > 0 };
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

function parseSkillsArgs(argv: string[]): { sub: string; root: string; json: boolean } {
  const sub = argv[0];
  if (sub === undefined || (sub !== 'sync' && sub !== 'list')) {
    usage(2);
  }
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a === '--root') {
      i += 1;
      continue;
    }
    if (!a.startsWith('-') || !BOOL_FLAGS.has(a)) {
      console.error(
        `error: unexpected ${a.startsWith('-') ? 'option' : 'argument'} ${JSON.stringify(a)} — see \`bro skills --help\``
      );
      process.exit(2);
    }
  }
  return {
    sub,
    root: resolve(flag(rest, '--root') ?? process.cwd()),
    json: rest.includes('--json'),
  };
}

export function runSkillsCommand(argv: string[]): void {
  if (hasHelpFlag(argv)) {
    usage(0);
  }
  const { sub, root, json } = parseSkillsArgs(argv);
  const cfg = (loadBroConfig(root).skills ?? skillsSection(undefined)) as SkillsConfig;
  if (sub === 'sync') {
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
      if (drift.length > 0) {
        for (const d of drift) {
          console.log(`✗ ${d.name} — ${d.kind}${d.kind === 'drifted' ? ' (content ≠ lock)' : ''}`);
        }
      }
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
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
