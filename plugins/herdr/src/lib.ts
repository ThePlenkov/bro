/**
 * bro ↔ herdr plugin shared plane reads. Everything here is READ-ONLY
 * against bro: the only bro writes in this plugin are the documented
 * command-plane verbs (`bro next`, `bro work enter`,
 * `bro review act status`, `bro notify`). Claims, `.work` markers,
 * `agents.json`, `.exit` records — those come from the work itself,
 * never from us (spec bro-762eh).
 *
 * Runs under `node` ≥22.18 native TS (the floor bro itself requires).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

export const HERDR = process.env.HERDR_BIN_PATH ?? 'herdr';
export const BRO = process.env.BRO_BIN_PATH ?? 'bro';
export const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
export const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ??
  join(process.env.HOME ?? '/tmp', '.config', 'bro-herdr-plugin');
export const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(STATE_DIR, 'config');

export interface RunOut {
  code: number;
  out: string;
  err: string;
}

export function run(cmd: string, args: string[], cwd?: string): RunOut {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return {
    code: r.status ?? (r.error !== undefined ? -1 : 0),
    out: r.stdout ?? '',
    err: r.stderr ?? (r.error !== undefined ? String(r.error) : ''),
  };
}

/** `herdr <args>` → `.result` — the CLI is the plugin's whole API surface. */
export function herdr<T>(args: string[], cwd?: string): T {
  const r = run(HERDR, args, cwd);
  if (r.code !== 0) {
    throw new Error(`herdr ${args.join(' ')} → ${r.err.trim() || r.out.trim() || r.code}`);
  }
  return (JSON.parse(r.out) as { result: T }).result;
}

/** `herdr` whose failure we want to see rather than catch — probes only. */
export function herdrTry<T>(args: string[], cwd?: string): T | undefined {
  try {
    return herdr<T>(args, cwd);
  } catch {
    return undefined;
  }
}

export function bro(args: string[], cwd: string): string {
  const r = run(BRO, args, cwd);
  if (r.code !== 0) {
    throw new Error(`bro ${args.join(' ')} → ${r.err.trim() || r.out.trim() || r.code}`);
  }
  return r.out;
}

export function broJson<T>(args: string[], cwd: string): T {
  return JSON.parse(bro(args, cwd)) as T;
}

// --- context ---------------------------------------------------------------

export interface PluginContext {
  workspace?: { workspace_id?: string; label?: string };
  pane?: { pane_id?: string; cwd?: string };
  focused_pane?: { pane_id?: string; cwd?: string };
  tab?: { tab_id?: string };
  worktree?: { checkout_path?: string; repo_root?: string; repo_key?: string };
  selected_text?: string;
  clicked_url?: string;
  invocation_source?: string;
  [k: string]: unknown;
}

export function ctxJson(): PluginContext {
  try {
    const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
    return raw !== undefined && raw !== '' ? (JSON.parse(raw) as PluginContext) : {};
  } catch {
    return {};
  }
}

export function gitTop(dir: string): string | null {
  const r = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.out.trim() : null;
}

function gitCommonDir(dir: string): string | null {
  const r = run('git', ['-C', dir, 'rev-parse', '--git-common-dir'], dir);
  if (r.code !== 0) return null;
  const p = r.out.trim();
  return p === '' ? null : isAbsolute(p) ? p : resolve(dir, p);
}

/** The bro repo this plugin reconciles. A linked plugin lives inside the
 *  repo so `git` answers; an installed copy falls back to the invocation
 *  context's worktree repo. */
export function repoDir(ctx: PluginContext = ctxJson()): string {
  const cw = ctx.worktree?.repo_root ?? ctx.worktree?.checkout_path;
  const ctxTop = typeof cw === 'string' ? gitTop(cw) : null;
  const top = ctxTop ?? gitTop(PLUGIN_ROOT);
  if (top === null) {
    throw new Error(
      'no bro repo resolvable — link the plugin inside the repo or invoke from its worktree'
    );
  }
  return top;
}

// --- bro planes ------------------------------------------------------------

export interface StatusAgent {
  id: string;
  agentId?: string;
  backend: string;
  step?: string;
  state: string;
  cause?: string;
  pid?: number;
  worktree?: string;
  log?: string;
}

export interface StatusWorktree {
  name: string;
  path: string;
  branch?: string;
  state?: string;
  claim?: string;
  main?: boolean;
  here?: boolean;
}

export interface BroStatus {
  dir: string;
  worktrees: StatusWorktree[];
  beads: { inProgress: Array<{ id: string; title: string }> };
  fleet: { maxConcurrent: number; agents: StatusAgent[] };
  loop: {
    stallMin: number;
    runs: Array<{
      beadId: string;
      slug: string;
      state: string;
      pid?: number;
      worktree?: string;
      log?: string;
      silentMs?: number | null;
    }>;
  };
}

export function broStatus(dir: string): BroStatus {
  return broJson<BroStatus>(['fleet', 'status', '--json'], dir);
}

export interface FleetRow {
  mol: string;
  step: string;
  title?: string;
  state: string;
  agent?: string;
  worktree?: string;
  pr?: string;
  prNum?: number;
}

export function broFleet(dir: string): { rows: FleetRow[] } {
  return broJson<{ rows: FleetRow[] }>(['fleet', '--json'], dir);
}

/** The shared agent registry — `<git-common>/bro/agents.json`, a
 *  spec-blessed read plane (molStep → attempt record). Status rows
 *  join on the molStep key. */
export interface AgentEntry {
  agentId?: string;
  backend?: string;
  worktree?: string;
  log?: string;
  pid?: number;
  [k: string]: unknown;
}

export function agentsJson(repo: string): Record<string, AgentEntry> {
  const gd = gitCommonDir(repo);
  if (gd === null) return {};
  try {
    const v = JSON.parse(readFileSync(join(gd, 'bro', 'agents.json'), 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, AgentEntry>)
      : {};
  } catch {
    return {};
  }
}

/** Live `.work` marker detail lines — the session-armed occupancy plane.
 *  Same rules as bro's own scan: owner pid+start alive, or ownerless
 *  within the 24h live window; detail-less markers are residue. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000;

function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return stat.slice(close + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number, start?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (start === undefined || start === '') return true;
  const st = procStart(pid);
  return st === null || st === start;
}

/** `owner <pid> <start>` on marker line 1 — both parts or there is no
 *  owner pin at all. */
function ownerPin(parts: string[]): { pid: number; start: string } | undefined {
  const pid = Number(parts[1]);
  const start = parts[2] ?? '';
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (start === '') return undefined;
  return { pid, start };
}

/** Owner-pinned liveness: the marker's recorded pid+start must still
 *  answer. null = not owner-pinned (caller falls to the time window). */
function markerOwnerAlive(firstLine: string): boolean | null {
  const pin = ownerPin(firstLine.trim().split(' '));
  return pin === undefined ? null : pidAlive(pin.pid, pin.start);
}

function markerLive(firstLine: string, mtimeMs: number, now: number): boolean {
  return markerOwnerAlive(firstLine) ?? mtimeMs >= now - LIVE_SESSION_MS;
}

/** Detail lines of one `.work` marker — empty when dead or unreadable. */
function markerDetails(path: string, now: number): string[] {
  try {
    const st = statSync(path);
    const lines = readFileSync(path, 'utf8').split('\n');
    if (!markerLive(lines[0] ?? '', st.mtimeMs, now)) return [];
    return lines
      .slice(1)
      .map(d => d.trim())
      .filter(t => t !== '');
  } catch {
    return [];
  }
}

/** Detail lines of live `<session>.work` markers under the common hooks
 *  dir — `agent-*` markers are the registry's lane, skipped here. */
export function armedWorkDetails(repo: string, now = Date.now()): string[] {
  const gd = gitCommonDir(repo);
  if (gd === null) return [];
  const hooks = join(gd, 'bro', 'hooks');
  try {
    return readdirSync(hooks)
      .filter(f => f.endsWith('.work') && !f.startsWith('agent-'))
      .flatMap(f => markerDetails(join(hooks, f), now));
  } catch {
    return [];
  }
}

// --- herdr planes ----------------------------------------------------------

export interface HerdrWorktree {
  path: string;
  branch?: string;
  label?: string;
  open_workspace_id?: string;
}

export interface HerdrWorktreeList {
  source: { repo_root?: string; source_checkout_path?: string; source_workspace_id?: string };
  worktrees: HerdrWorktree[];
}

export function worktreeList(cwd: string): HerdrWorktreeList {
  return herdr<HerdrWorktreeList>(['worktree', 'list', '--cwd', cwd]);
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  pane_count?: number;
  worktree?: { checkout_path?: string; repo_key?: string; repo_root?: string };
}

export function workspaceList(): HerdrWorkspace[] {
  return herdr<{ workspaces: HerdrWorkspace[] }>(['workspace', 'list']).workspaces;
}

export interface HerdrPane {
  pane_id: string;
  label?: string;
  cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent?: string;
}

export function paneList(workspaceId: string): HerdrPane[] {
  return herdr<{ panes: HerdrPane[] }>(['pane', 'list', '--workspace', workspaceId]).panes;
}

/** A success envelope that still carries no pane — or the explicit
 *  pane_not_found error code — counts as gone. */
function envelopeSaysGone(out: string): boolean {
  try {
    const d = JSON.parse(out) as { result?: { pane?: unknown }; error?: { code?: string } };
    return d.result?.pane === undefined || d.error?.code === 'pane_not_found';
  } catch {
    return false;
  }
}

/** Definitive absence only. `pane get` answers "gone" two ways — a
 *  non-zero exit whose output says pane_not_found, or a success
 *  envelope with no pane in result. Anything else (socket hiccup,
 *  timeout, unparseable output) is NOT proof: a flaky probe must never
 *  drop a mirror rec or spawn a duplicate pane. */
export function paneGone(paneId: string): boolean {
  const r = run(HERDR, ['pane', 'get', paneId]);
  return r.code !== 0
    ? /pane_not_found|not found/i.test(`${r.err} ${r.out}`)
    : envelopeSaysGone(r.out);
}

export function paneExists(paneId: string): boolean {
  return !paneGone(paneId);
}

/** Idle = everything in the foreground is the shell itself. Counting
 *  processes is wrong: a wrapper's `sleep`/builtin loop shows exactly
 *  one non-shell entry — one process is not one shell. */
export function paneIdle(paneId: string): boolean {
  const pi = herdrTry<{
    shell_pid?: number;
    foreground_processes?: { pid?: number }[];
  }>(['pane', 'process-info', '--pane', paneId]);
  if (pi === undefined) return false;
  const fg = pi.foreground_processes ?? [];
  return fg.every(proc => proc.pid === pi.shell_pid);
}

export function notify(title: string, body?: string): void {
  const args = ['notification', 'show', title];
  if (body !== undefined && body !== '') args.push('--body', body);
  try {
    herdr(args);
  } catch {
    // notification is advisory — never fail the action over it
  }
}

// --- plugin state ----------------------------------------------------------

export interface WorkspaceRec {
  ws: string;
  label: string;
  /** true only for workspaces this plugin opened — drift renames never
   *  touch workspaces a user named themselves. */
  managed?: boolean;
}

export interface MirrorRec {
  step: string;
  agentId?: string;
  pid?: number;
  /** process start token — reused pids must not pass as the worker. */
  pidStart?: string;
  log: string;
  worktree: string;
  workspace: string;
  pane_id: string;
  /** exit marker applied — the pane stays as a dead tail. */
  marked?: boolean;
}

export interface PluginState {
  /** worktree path → the workspace we opened (label drift is ours to fix). */
  workspaces: Record<string, WorkspaceRec>;
  /** molStep → mirror pane record. */
  mirrors: Record<string, MirrorRec>;
}

/** One state file per repository — two repos sharing the plugin state
 *  dir must never see each other's pane ids (a repo-B pass marking a
 *  repo-A pane exited is the failure this prevents). The scope is the
 *  canonical git common dir, so every linked worktree of one repo
 *  resolves to the same partition. */
export function stateScope(repo: string): string {
  const gd = gitCommonDir(repo) ?? repo;
  return createHash('sha1').update(gd).digest('hex').slice(0, 12);
}

function stateFile(scope: string): string {
  return join(STATE_DIR, `state-${scope}.json`);
}

export function loadState(scope: string): PluginState {
  try {
    const v = JSON.parse(readFileSync(stateFile(scope), 'utf8')) as Partial<PluginState>;
    return {
      workspaces: typeof v.workspaces === 'object' && v.workspaces !== null ? v.workspaces : {},
      mirrors: typeof v.mirrors === 'object' && v.mirrors !== null ? v.mirrors : {},
    };
  } catch {
    return { workspaces: {}, mirrors: {} };
  }
}

export function saveState(scope: string, s: PluginState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = stateFile(scope);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, p);
}

/** Small config file under HERDR_PLUGIN_CONFIG_DIR — `key = value` TOML
 *  subset; we only need `agent_kind`. Line-scanned with a static
 *  pattern — a key never becomes regex source. */
export function configValue(key: string, fallback: string): string {
  try {
    const raw = readFileSync(join(CONFIG_DIR, 'config.toml'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([\w.-]+)\s*=\s*"([^"]+)"/.exec(line);
      if (m?.[1] === key) return m[2] ?? fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export { basename, dirname, join, resolve };
