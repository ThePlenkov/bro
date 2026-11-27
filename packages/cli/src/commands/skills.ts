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
  writeFileSync,
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
  commandOnPath,
  pinnedAddArgs,
  resolveSkillsBin,
  resolveGithubRef,
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
  source?: SkillSource;
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
    return { name, source: src, state: 'missing' };
  }
  if (!lst.isSymbolicLink()) {
    return {
      name,
      source: src,
      state: 'present',
      detail: 'a real dir, not the expected symlink',
    };
  }
  if (resolve(skillsDirOf(root), readlinkSync(link)) !== want) {
    return { name, source: src, state: 'error', detail: 'link points elsewhere' };
  }
  return { name, source: src, state: 'linked' };
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
        source: src,
        state: 'pending',
        detail: 'declared — nothing locked yet (bro skills sync installs)',
      },
    ];
  }
  return names.map(name => ({ name, source: src, state: lockedState(ctx, name) }));
}

/** One declared source → its rows. */
function rowsForSource(src: SkillSource, ctx: ReconcileCtx): SkillRow[] {
  if (src.kind === 'invalid') {
    return [{ name: src.raw, source: src, state: 'error', detail: src.reason }];
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
      source: parseSkillSource(locked.get(name)?.source ?? ''),
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
  resolveRef: (repo: string) => string | null;
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
  const ref = src.kind === 'github' ? ctx.resolveRef(src.repo) : undefined;
  if (src.kind === 'github' && ref === null) {
    return { label, state: 'error', detail: `could not resolve ${src.repo} default branch HEAD` };
  }
  const proc = ctx.spawn(ctx.bin, ctx.root, pinnedAddArgs(src, ctx.cfg.agents, ref ?? undefined));
  if (spawnFailed(proc)) {
    return { label, state: 'error', detail: `skills add failed — ${spawnDetail(proc)}` };
  }
  if (src.kind === 'github' && ref !== undefined && ref !== null) {
    recordLockRef(ctx.root, src.repo, ref);
  }
  return { label, state: 'ok' };
}

/** The skills CLI records the source and content hash, but older releases do
 * not retain the revision supplied in the source spec. Preserve the resolver
 * result in bro's lock contract without changing any other lock fields. */
function recordLockRef(root: string, repo: string, ref: string): void {
  const lockPath = join(root, 'skills-lock.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return;
    const skills = (parsed as { skills?: unknown }).skills;
    if (typeof skills !== 'object' || skills === null) return;
    for (const value of Object.values(skills)) {
      if (typeof value === 'object' && value !== null) {
        const entry = value as { source?: unknown; ref?: unknown };
        if (entry.source === repo) entry.ref = ref;
      }
    }
    writeFileSync(lockPath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    // The CLI's successful install remains useful; verification reports a
    // missing/unpinned lock rather than claiming a pin we could not record.
  }
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
  probe: BinProbe = commandOnPath,
  resolveRef: (repo: string) => string | null = spawn === spawnSkills
    ? resolveGithubRef
    : () => 'test'
): { steps: SyncStep[]; rows: SkillRow[]; drift: SkillDrift[]; failed: boolean } {
  const ctx: SyncCtx = {
    root,
    cfg,
    bin: resolveSkillsBin(root, cfg.bin, probe),
    spawn,
    resolveRef,
  };
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
    const src = r.source !== undefined ? `  ${r.source.raw}` : '';
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

function jsonRows(rows: SkillRow[]): Array<Omit<SkillRow, 'source'> & { source: string }> {
  return rows.map(row => ({ ...row, source: row.source?.raw ?? '' }));
}

// --- command ------------------------------------------------------------------------

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro skills <command> [options]

Materialise config-declared agent-skill deps into .agents/skills/.

Commands:
  add <source>    add an external source to the project vendor tree
  update <source> update locked skills from an external source
  remove <source> remove all locked skills from an external source
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
type SkillSub = 'sync' | 'list' | 'add' | 'update' | 'remove';
const SKILL_SUBS = new Set<SkillSub>(['sync', 'list', 'add', 'update', 'remove']);

function isSkillSub(value: string | undefined): value is SkillSub {
  return value !== undefined && SKILL_SUBS.has(value as SkillSub);
}

function isMutationSub(sub: SkillSub): sub is 'add' | 'update' | 'remove' {
  return sub === 'add' || sub === 'update' || sub === 'remove';
}

function mutationSource(sub: SkillSub, rest: string[]): string | undefined {
  if (!isMutationSub(sub)) {
    return undefined;
  }
  const source = rest.shift();
  if (source === undefined || source.startsWith('-')) {
    console.error(`error: ${sub} needs one <source> — see \`bro skills --help\``);
    process.exit(2);
  }
  return source;
}

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

function parseSkillsArgs(argv: string[]): {
  sub: SkillSub;
  source?: string;
  root: string;
  json: boolean;
} {
  const sub = argv[0];
  if (!isSkillSub(sub)) {
    usage(2);
  }
  const rest = argv.slice(1);
  const source = mutationSource(sub, rest);
  rejectStrays(rest);
  return {
    sub,
    source,
    root: resolve(flag(rest, '--root') ?? process.cwd()),
    json: rest.includes('--json'),
  };
}

interface SkillMutation {
  command: 'add' | 'update' | 'remove';
  source: SkillSource;
  root: string;
  cfg: SkillsConfig;
  bin?: SkillsBin;
  spawn?: SpawnRunner;
  probe?: BinProbe;
  resolveRef?: (repo: string) => string | null;
}

/** Resolve the names covered by a source.  The lock is authoritative for
 * update/remove because the upstream CLI's update/remove commands take skill
 * names, while bro's public API takes the original source. */
function mutationNames(source: SkillSource, root: string): string[] {
  const locked = readSkillLock(root);
  if (source.kind === 'github' || source.kind === 'url') {
    return lockNamesFor(source, locked);
  }
  return source.kind === 'invalid' ? [] : [localSkillName(root, source.path)];
}

export function runSkillMutation(input: SkillMutation): {
  ok: boolean;
  args: string[];
  detail?: string;
} {
  const source = input.source;
  if (source.kind === 'invalid' || source.kind === 'local') {
    return {
      ok: false,
      args: [],
      detail:
        source.kind === 'invalid'
          ? source.reason
          : 'mutating external skills requires a github or https source',
    };
  }
  const bin = input.bin ?? resolveSkillsBin(input.root, input.cfg.bin, input.probe);
  const spawn = input.spawn ?? spawnSkills;
  const names = mutationNames(source, input.root);
  const ref =
    input.command === 'add' && source.kind === 'github'
      ? (input.resolveRef ?? (input.spawn === undefined ? resolveGithubRef : () => 'test'))(
          source.repo
        )
      : undefined;
  if (input.command === 'add' && source.kind === 'github' && ref === null) {
    return { ok: false, args: [], detail: `could not resolve ${source.repo} default branch HEAD` };
  }
  const args =
    input.command === 'add'
      ? pinnedAddArgs(source, input.cfg.agents, ref ?? undefined)
      : [input.command, ...names, '-y'];
  if (input.command !== 'add' && names.length === 0) {
    return {
      ok: false,
      args,
      detail: `no locked skills match ${source.raw}`,
    };
  }
  const proc = spawn(bin, input.root, args);
  if (spawnFailed(proc)) {
    return { ok: false, args, detail: spawnDetail(proc) };
  }
  if (source.kind === 'github' && ref !== undefined && ref !== null) {
    recordLockRef(input.root, source.repo, ref);
  }
  return { ok: true, args };
}

function cmdMutation(
  command: 'add' | 'update' | 'remove',
  source: string,
  root: string,
  cfg: SkillsConfig,
  json: boolean
): void {
  const result = runSkillMutation({ command, source: parseSkillSource(source), root, cfg });
  if (json) {
    console.log(JSON.stringify({ command: `skills ${command}`, data: result }));
  } else if (result.ok) {
    console.log(`✓ ${command} ${source}`);
  } else {
    console.error(`✗ ${command} ${source} — ${result.detail ?? 'failed'}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

function cmdSync(root: string, cfg: SkillsConfig, json: boolean): void {
  const { steps, rows, drift, failed } = runSync(root, cfg);
  if (json) {
    console.log(
      JSON.stringify({
        command: 'skills sync',
        data: {
          steps,
          rows: jsonRows(rows),
          drift: drift.map(d => ({ name: d.name, kind: d.kind })),
        },
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
    console.log(JSON.stringify({ command: 'skills list', data: { rows: jsonRows(rows) } }));
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
  const parsed = parseSkillsArgs(argv);
  const { sub, source, root, json } = parsed;
  const cfg = (loadBroConfig(root).skills ?? skillsSection(undefined)) as SkillsConfig;
  switch (sub) {
    case 'add':
    case 'update':
    case 'remove':
      cmdMutation(sub, source!, root, cfg, json);
      return;
    case 'sync':
      cmdSync(root, cfg, json);
      return;
    case 'list':
      cmdList(root, cfg, json);
      return;
  }
}
