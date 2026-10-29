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
 *
 * Modules: skills-sources.ts (source grammar + lock matching),
 * skills-spawn.ts (bin resolution + process mechanics),
 * skills-links.ts (.agents/skills local symlinks),
 * skills-config.ts (bro.config section).
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { lockNamesFor, parseSkillSource, type SkillSource } from './skills-sources.ts';
import {
  addArgs,
  commandOnPath,
  resolveSkillsBin,
  spawnDetail,
  spawnFailed,
  spawnSkills,
  type BinProbe,
  type SkillsBin,
  type SpawnRunner,
} from './skills-spawn.ts';
import { ensureLocalLink, localSkillName, skillsDirOf } from './skills-links.ts';
import { loadBroConfig } from '../plugins.ts';

export { skillsSection, type SkillsConfig } from './skills-config.ts';
export { parseSkillSource, type SkillSource } from './skills-sources.ts';
export {
  commandOnPath,
  resolveSkillsBin,
  type SkillsBin,
  type SpawnRunner,
} from './skills-spawn.ts';
export { ensureLocalLink, localSkillName, type LocalLink } from './skills-links.ts';

// --- reconcile -----------------------------------------------------------------

export interface SkillRow {
  name: string;
  source: string;
  state: 'ok' | 'linked' | 'present' | 'missing' | 'drifted' | 'extra' | 'pending' | 'error';
  detail?: string;
}

/** `.agents/skills/<name>/SKILL.md` exists. */
function installed(root: string, name: string): boolean {
  return existsSync(join(skillsDirOf(root), name, 'SKILL.md'));
}

/** Every skill name a declared source covers — lock-matched names plus
 *  the local link's own name. */
function coveredNames(
  root: string,
  declared: SkillSource[],
  locked: Map<string, LockedSkill>
): Set<string> {
  const covered = new Set<string>();
  for (const src of declared) {
    for (const n of lockNamesFor(src, locked)) {
      covered.add(n);
    }
    if (src.kind === 'local') {
      covered.add(localSkillName(root, src.path));
    }
  }
  return covered;
}

/** Skill names materialized on disk — an absent `.agents/skills` dir
 *  reads as none. */
function diskSkillNames(root: string): string[] {
  try {
    return readdirSync(skillsDirOf(root), { withFileTypes: true }).map(e => e.name);
  } catch {
    // no .agents/skills dir — nothing on disk to report
    return [];
  }
}

/** Lock entries and on-disk skill dirs not covered by any declared
 *  source — reported, never removed. */
function extraNames(
  root: string,
  declared: SkillSource[],
  locked: Map<string, LockedSkill>
): string[] {
  const covered = coveredNames(root, declared, locked);
  const extras = new Set([...locked.keys(), ...diskSkillNames(root)].filter(n => !covered.has(n)));
  return [...extras].sort((a, b) => a.localeCompare(b));
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
    const name = src.kind === 'github' ? src.repo : src.kind === 'url' ? src.url : src.raw;
    return [
      {
        name,
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
  const ctx: ReconcileCtx = {
    root,
    locked,
    driftByName: new Map(drift.map(d => [d.name, d])),
  };
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
  return steps.map(s => {
    const detail = s.detail !== undefined ? ` — ${s.detail}` : '';
    return `${icon[s.state]} ${s.label}${detail}`;
  });
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

/** A flag spelled the way the command accepts it — `--root=<dir>` or a
 *  registered bool; `--root <dir>` consumes its value separately. */
function knownFlag(a: string): boolean {
  if (!a.startsWith('-')) {
    return false;
  }
  if (a.startsWith('--root=')) {
    return true;
  }
  return BOOL_FLAGS.has(a);
}

/** Stray args after the sub — `--root` consumes its value; anything
 *  else that isn't a known bool flag is a usage error. */
function rejectStrays(rest: string[]): void {
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === undefined) {
      break;
    }
    if (a === '--root') {
      i += 1;
      continue;
    }
    if (knownFlag(a)) {
      continue;
    }
    const kind = a.startsWith('-') ? 'option' : 'argument';
    console.error(`error: unexpected ${kind} ${JSON.stringify(a)} — see \`bro skills --help\``);
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
      const note = d.kind === 'drifted' ? ' (content ≠ lock)' : '';
      console.log(`✗ ${d.name} — ${d.kind}${note}`);
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
