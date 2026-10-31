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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

export const HERDR = process.env.HERDR_BIN_PATH ?? 'herdr';
export const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
// The plugin and the CLI ship from one repo — prefer the checkout's own
// build over a possibly stale `bro` on PATH (a linked dev worktree must
// spawn status panes on its own dist, not the global install).
const REPO_BRO = join(PLUGIN_ROOT, '..', '..', 'packages', 'cli', 'dist', 'index.js');
export const BRO = process.env.BRO_BIN_PATH ?? (existsSync(REPO_BRO) ? REPO_BRO : 'bro');
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
    // no status is never success — a signal-killed child reports
    // status=null, so does a spawn error; both are failure
    code: r.status ?? -1,
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

/** `herdr` verbs that answer exit-0-and-nothing on success (`pane run`
 *  prints no envelope) — for those the exit code IS the answer; the
 *  envelope parse in `herdr` would call an empty stdout a failure. */
export function herdrOk(args: string[], cwd?: string): boolean {
  return run(HERDR, args, cwd).code === 0;
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
  // flat API-shape keys — the socket invocation context delivers these
  // alongside (or instead of) the nested objects above
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  tab_id?: string;
  tab_label?: string;
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

export function gitCommonDir(dir: string): string | null {
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
  beads: { inProgress: Array<{ id: string; title: string; link?: string }> };
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

/** "Gone" is a definitive absence — ENOENT/ENOTDIR only. Any other
 *  stat failure (EACCES, transient fs errors) is NOT proof the
 *  worktree vanished; same discipline `paneGone` encodes. */
export function worktreeGone(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** Silence bucketing shared by the diff key and the label token — a
 *  token only moves when its bucket does, so rename churn is per-5min
 *  under an hour, hourly above, never per-tick. */
export function silentBucketMin(silentMs: number | null | undefined): number | null {
  if (silentMs === null || silentMs === undefined || !Number.isFinite(silentMs)) return null;
  const min = silentMs / 60_000;
  return min >= 60 ? Math.floor(min / 60) * 60 : Math.max(0, Math.floor(min / 5) * 5);
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

/** The pane labels each convergence role claims — a pane carrying one
 *  role's label is never an idle-grab candidate for another, even
 *  unbound: the label is an intent marker, not just a record key. */
export const RENDER_LABEL = 'bro: events';
export const STATUS_LABEL = 'bro: status';
export const SESSION_LABEL = 'bro: session';

/** Every bro-role label — a generic "any idle pane" grab skips all of
 *  them; only the owning role adopts its own orphans. */
export const BRO_LABELS: ReadonlySet<string> = new Set([RENDER_LABEL, STATUS_LABEL, SESSION_LABEL]);

/** Pane ids bound to a bro-managed role (renderer, status, mirror) —
 *  a generic "any idle pane" grab must never steal one out from under
 *  its recorded owner: a dead status view re-arms through its own
 *  record, not through the renderer's spare-pane path. */
export function boundPaneIds(state: PluginState): Set<string> {
  const ids = new Set<string>();
  for (const r of Object.values(state.renderers)) ids.add(r.pane_id);
  for (const r of Object.values(state.statuses)) ids.add(r.pane_id);
  for (const r of Object.values(state.sessions)) ids.add(r.pane_id);
  for (const r of Object.values(state.mirrors)) ids.add(r.pane_id);
  return ids;
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
  /** true only for workspaces this plugin opened — that's how the
   *  daemon projector learns it owns the label; a workspace a user
   *  named themselves is never relabeled (spec bro-u19mq). */
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

export interface RendererRec {
  workspace: string;
  /** the worktree path the workspace serves — the tail's cwd. */
  worktree: string;
  pane_id: string;
}

/** The `bro: status` pane record (spec bro-idsat) — one per managed
 *  workspace, running `bro herdr status-view` as the LED's primary
 *  self-reporter. The daemon projector reads this binding for its
 *  backstop push. */
export interface StatusPaneRec {
  workspace: string;
  worktree: string;
  pane_id: string;
}

export interface PluginState {
  /** worktree path → the workspace we opened (the projector's
   *  ownership ledger — it relabels only `managed` records). */
  workspaces: Record<string, WorkspaceRec>;
  /** molStep → mirror pane record. */
  mirrors: Record<string, MirrorRec>;
  /** worktree path → the event-tail pane record (one per managed ws). */
  renderers: Record<string, RendererRec>;
  /** worktree path → the status-pane record (one per managed ws). */
  statuses: Record<string, StatusPaneRec>;
  /** worktree path → the session-pane record (one per managed ws —
   *  spec bro-nwl5g's `bro herdr session-view` renderer). */
  sessions: Record<string, StatusPaneRec>;
  /** worktree path → first-gone mtime — the reaper's two-sighting grace. */
  gone: Record<string, number>;
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

function loadStateFromPath(p: string): PluginState | null {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<PluginState>;
    return {
      workspaces: typeof v.workspaces === 'object' && v.workspaces !== null ? (v.workspaces as Record<string, WorkspaceRec>) : {},
      mirrors: typeof v.mirrors === 'object' && v.mirrors !== null ? (v.mirrors as Record<string, MirrorRec>) : {},
      renderers: typeof v.renderers === 'object' && v.renderers !== null ? (v.renderers as Record<string, RendererRec>) : {},
      statuses: typeof v.statuses === 'object' && v.statuses !== null ? (v.statuses as Record<string, StatusPaneRec>) : {},
      sessions: typeof v.sessions === 'object' && v.sessions !== null ? (v.sessions as Record<string, StatusPaneRec>) : {},
      gone: typeof v.gone === 'object' && v.gone !== null ? (v.gone as Record<string, number>) : {},
    };
  } catch {
    return null;
  }
}

export function loadState(scope: string): PluginState {
  const cur = loadStateFromPath(stateFile(scope)) ?? { workspaces: {}, mirrors: {}, renderers: {}, statuses: {}, gone: {} };

  // try legacy locations and merge any managed workspaces we don't have
  const home = process.env.HOME ?? (typeof homedir === 'function' ? homedir() : '/root');
  const legacyDirs = [
    join(home, '.local', 'state', 'herdr', 'plugins', 'bro.fleet'),
    join(home, '.local', 'state', 'herdr', 'plugins'),
    join(home, '.local', 'state', 'herdr'),
    join(home, '.config', 'herdr', 'plugins', 'bro.fleet'),
    join(home, '.config', 'herdr', 'plugins'),
    join(home, '.config', 'bro-herdr-plugin'),
    join(home, '.local', 'share', 'herdr', 'plugins', 'bro.fleet'),
    join(home, '.local', 'share', 'herdr', 'plugins'),
    join(home, '.local', 'share', 'herdr'),
  ];
  for (const dir of legacyDirs) {
    try {
      const candidates = [
        join(dir, `state-${scope}.json`),
        join(dir, 'state.json'),
      ];
      for (const c of candidates) {
        const st = loadStateFromPath(c);
        if (!st) continue;
        for (const [k, v] of Object.entries(st.workspaces || {})) {
          if (cur.workspaces[k] === undefined) {
            cur.workspaces[k] = v as any;
          } else if ((v as any)?.managed && !(cur.workspaces[k] as any)?.managed) {
            cur.workspaces[k] = { ...(cur.workspaces[k] as any), managed: true };
          }
        }
        // merge mirrors/renderers/statuses/gone if missing
        for (const k of Object.keys(st.mirrors || {})) {
          if (cur.mirrors[k] === undefined) cur.mirrors[k] = (st.mirrors as any)[k];
        }
        for (const k of Object.keys(st.renderers || {})) {
          if (cur.renderers[k] === undefined) cur.renderers[k] = (st.renderers as any)[k];
        }
        for (const k of Object.keys(st.statuses || {})) {
          if (cur.statuses[k] === undefined) cur.statuses[k] = (st.statuses as any)[k];
        }
        for (const k of Object.keys(st.gone || {})) {
          if (cur.gone[k] === undefined) cur.gone[k] = (st.gone as any)[k];
        }
      }
    } catch {}
  }
  return cur;
}

export function saveState(scope: string, s: PluginState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const p = stateFile(scope);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, p);
}

/** A lock older than this is a dead holder's — a live converge never
 *  takes minutes, so breaking it is safe. */
const STALE_LOCK_MS = 180_000;
/** How long a session waits on a live lock before running unlocked —
 *  a wedged fs must never freeze the plugin. */
const LOCK_WAIT_MS = 10_000;

function lockStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
  } catch {
    // vanished between our failed mkdir and this stat — breakable
    return true;
  }
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A mkdir mutex around a scope's load→converge→save span — mkdir is
 *  the one atomic create-if-absent the fs gives. Without it two
 *  sessions reconciling the same repo read-modify-write the same file
 *  and the last save silently drops the other's workspace/mirror
 *  records (review finding on bro-u19mq). A stale lock is broken and
 *  retaken; a live one outlasting LOCK_WAIT_MS runs unlocked —
 *  correctness degrades to the old race, never to a hang. */
export function withStateLock<T>(scope: string, fn: () => T): T {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = join(STATE_DIR, `state-${scope}.lock`);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (lockStale(lock)) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          // raced another breaker — keep spinning
        }
        continue;
      }
      if (Date.now() >= until) return fn();
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // a breaker already took it — nothing to release
    }
  }
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

const WORD_ESCAPES: Record<string, string> = { n: '\n', t: '\t' };
const unescapeWord = (s: string): string =>
  s.replace(/\\(.)/g, (_, c: string) => WORD_ESCAPES[c] ?? c);

const quotedBody = (s: string, q: string): string => {
  if (s.length < 2 || !s.endsWith(q)) throw new Error(`unclosed ${q} quote`);
  return s.slice(1, -1);
};

/** One lexer segment → its literal text; malformed input is a loud
 *  usage error. Single-quoted bodies stay literal, double-quoted and
 *  bare segments get \x escapes. */
const segmentText = (s: string): string => {
  if (s === '\\') throw new Error('trailing backslash');
  const q = s[0] as string;
  if (q !== '"' && q !== "'") return unescapeWord(s);
  const body = quotedBody(s, q);
  return q === '"' ? unescapeWord(body) : body;
};

interface WordAcc {
  out: string[];
  cur: string;
  open: boolean;
}

/** Position coverage — a regex gap means an unlexable char slipped
 *  through (only a lone `\` can: every other byte matches some
 *  alternative). Returns the new offset. */
const ate = (m: RegExpMatchArray, pos: number): number => {
  if ((m.index ?? -1) !== pos) throw new Error(`malformed input at offset ${pos}`);
  return pos + m[0].length;
};

/** Whitespace closes an open word; anything else accrues into it. */
const take = (a: WordAcc, s: string): void => {
  if (!/^\s+$/.test(s)) {
    a.cur += segmentText(s);
    a.open = true;
    return;
  }
  if (a.open) a.out.push(a.cur);
  a.cur = '';
  a.open = false;
};

/** Minimal shell-words split for operator-selected text — whitespace-
 *  separated argv honoring '…', "…" and \x escapes. Empty quoted
 *  tokens (""/'') survive as empty argv — `cur` alone can't tell a
 *  word that produced nothing from no word at all, so `open` tracks
 *  it. NOT a shell: no $expansion, globs, `;` or `|` — selected text
 *  can never re-parse into a different program. An unclosed quote is
 *  a usage error, named as such. */
export function shellWords(text: string): string[] {
  const SEGMENT = /"(?:\\.|[^"\\])*"?|'[^']*'?|\\.|[^\s'"\\]+|\s+/g;
  const acc = { out: [] as string[], cur: '', open: false };
  let pos = 0;
  for (const m of text.matchAll(SEGMENT)) {
    pos = ate(m, pos);
    take(acc, m[0]);
  }
  if (pos !== text.length) throw new Error('trailing backslash');
  if (acc.open) acc.out.push(acc.cur);
  return acc.out;
}

export { basename, dirname, join, resolve };
