/** The opencode external-activity plane — a /proc scan plus the host's
 *  state files (spec bro-eqi2d).
 *
 *  opencode leaves no session-lock dir a plane can count; the live
 *  signal is the process table: an `opencode` argv[0] that is alive.
 *  Long-running infrastructure (`opencode serve`, `--service`) is NOT a
 *  session — it idles alongside the account forever, so only session
 *  argv counts. Ownership rides the shared environ badge (BRO_AGENT_ID /
 *  BRO_HOOKS=0): a bro-spawned opencode worker is the fleet's own, an
 *  unreadable environ is external (fail closed).
 *
 *  Idleness has no per-session file to read: the freshest mtime of the
 *  shared state (`opencode.db`, `opencode.db-wal`, `log/*.log`) is the
 *  last proven activity for the whole host. A live foreign opencode
 *  whose evidence is all stale has gone idle; one with no readable
 *  evidence cannot prove idle and counts active.
 *
 *  External-only: this plane registers no SessionPlane — an opencode
 *  session quota stays a config error (`agents.opencode.maxSessions`
 *  has no registered plane) rather than silently unguarding. */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ownedEnviron,
  pidAlive,
  registerExternalPlane,
  SpawnError,
  type ExternalActivity,
  type ExternalActivityPlane,
  type ExternalProbeCtx,
} from '@broject/core';

/** `~/.local/share/opencode` under the spawner's env — XDG_DATA_HOME
 *  wins like every other plane's derivation; `agents.opencode.dataDir`
 *  overrides for tests/odd installs. */
export function opencodeDataDir(
  bag?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): string {
  const override = bag?.['dataDir'];
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  const xdg = env['XDG_DATA_HOME'];
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : join(
          env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir(),
          '.local',
          'share'
        );
  return join(base, 'opencode');
}

/** The /proc root the scan reads — `agents.opencode.procDir` overrides
 *  for tests (a scripted /proc tree). */
export function opencodeProcDir(bag?: Record<string, unknown>): string {
  const override = bag?.['procDir'];
  return typeof override === 'string' && override.trim() !== '' ? override : '/proc';
}

/** Is this /proc entry a live opencode SESSION? argv[0]'s basename is
 *  `opencode` or the resolved executable basename is `opencode`, and
 *  argv[1] is not a non-session subcommand (`serve` hosts sessions but
 *  works none itself — counting it would hold the guard on
 *  infrastructure alone). A missing cmdline cannot prove session-ness —
 *  it does not count (an unverifiable proc undercounts, never invents a
 *  session). */
function opencodeSessionArgv(cmdline: string, exeName = ''): boolean {
  const argv = cmdline.split('\0').filter(t => t !== '');
  const isOpencode = basename(argv[0] ?? '') === 'opencode' || basename(exeName) === 'opencode';
  if (!isOpencode) {
    return false;
  }
  return argv[1] !== 'serve' && argv[1] !== '--service';
}

/** The executable the kernel resolved for a /proc entry, or '' when
 *  unreadable. A symlink launch resolves to its target file. */
function exeNameOf(dir: string): string {
  try {
    return readlinkSync(join(dir, 'exe'));
  } catch {
    return '';
  }
}

/** The live pid a numeric /proc entry names — undefined for
 *  non-pid names and dead processes. */
function liveNumericPid(name: string): number | undefined {
  const pid = Number(name);
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
}

/** Does this /proc entry carry a session cmdline? An unreadable one
 *  cannot prove session-ness — it does not count (an unverifiable
 *  proc undercounts, never invents a session). */
function opencodeSessionEntry(dir: string): boolean {
  try {
    return opencodeSessionArgv(readFileSync(join(dir, 'cmdline'), 'utf8'), exeNameOf(dir));
  } catch {
    return false;
  }
}

/** Does this /proc entry's environ prove bro-ownership? An unreadable
 *  environ cannot prove it — the entry counts external, fail closed. */
function broOwnedEntry(dir: string): boolean {
  try {
    return ownedEnviron(readFileSync(join(dir, 'environ'), 'utf8'));
  } catch {
    return false;
  }
}

/** Parse proc environ (NUL-delimited) into a string env map. */
function parseProcEnviron(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of content.split('\0')) {
    if (part === '') continue;
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    env[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return env;
}

/** Read a process's environ; undefined when unreadable. */
function procEnviron(dir: string): Record<string, string> | undefined {
  try {
    return parseProcEnviron(readFileSync(join(dir, 'environ'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** One /proc entry's verdict — the pid when it is a live foreign
 *  opencode session, undefined otherwise. Also returns derived data dir
 *  from the process's own env (or marker for unknown). */
function foreignOpencodePid(
  procDir: string,
  name: string
): { pid: number; dataDir?: string; unknown: boolean } | undefined {
  const pid = liveNumericPid(name);
  const dir = join(procDir, name);
  if (pid === undefined || !opencodeSessionEntry(dir)) {
    return undefined;
  }
  if (broOwnedEntry(dir)) {
    return undefined;
  }
  const penv = procEnviron(dir);
  if (penv === undefined) {
    return { pid, unknown: true };
  }
  return { pid, dataDir: opencodeDataDir(undefined, penv), unknown: false };
}

/** Live foreign opencode session pids — opencode argv, alive, and not
 *  bro-owned. An unreadable cmdline is skipped; an unreadable environ
 *  counts as external (ownership cannot be proven). An unreadable
 *  /proc root fails closed like the devin scan — SpawnError
 *  'unavailable' rather than pretending zero sessions. */
export function foreignOpencodePids(
  procDir = '/proc'
): Array<{ pid: number; dataDir?: string; unknown: boolean }> {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new SpawnError(
      `cannot verify opencode sessions — ${procDir}: ${(err as Error).message}`,
      'unavailable'
    );
  }
  const pids: Array<{ pid: number; dataDir?: string; unknown: boolean }> = [];
  for (const name of names) {
    const res = foreignOpencodePid(procDir, name);
    if (res !== undefined) {
      pids.push(res);
    }
  }
  return pids;
}

/** The freshest mtime across the host's opencode state — the shared
 *  db (and its WAL, the hot file) plus the session log dir. Undefined
 *  when nothing could be stat'd: no provable activity at all. */
export function opencodeActivityMs(dataDir: string): number | undefined {
  let at: number | undefined;
  const stamp = (path: string): void => {
    try {
      const m = statSync(path).mtimeMs;
      if (at === undefined || m > at) {
        at = m;
      }
    } catch {
      // absent or raced away — the other stamps still apply
    }
  };
  stamp(join(dataDir, 'opencode.db'));
  stamp(join(dataDir, 'opencode.db-wal'));
  try {
    for (const name of readdirSync(join(dataDir, 'log'))) {
      stamp(join(dataDir, 'log', name));
    }
  } catch {
    // no log dir — db stamps carry the verdict
  }
  return at;
}

/** The probe — live foreign sessions PLUS proof of work inside the
 *  hold window. Each foreign pid's activity is read from its own data
 *  directory; the global agents.opencode.dataDir override applies to
 *  every pid. A pid with an unreadable environment or missing/unreadable
 *  stamp is active. */
export function opencodeExternalActivity(ctx: ExternalProbeCtx): ExternalActivity {
  const bag = ctx.agents['opencode'] ?? {};
  const procDir = opencodeProcDir(bag);
  const entries = foreignOpencodePids(procDir);
  if (entries.length === 0) {
    return { active: false };
  }
  const override = bag?.['dataDir'];
  for (const entry of entries) {
    if (entry.unknown) {
      return {
        active: true,
        detail: `${entries.length} opencode session(s) live outside this rig (pid ${entry.pid}) — no provable activity stamp`,
      };
    }
    const dataDir =
      typeof override === 'string' && override.trim() !== '' ? override : entry.dataDir;
    if (dataDir === undefined) {
      return {
        active: true,
        detail: `${entries.length} opencode session(s) live outside this rig (pid ${entry.pid}) — no provable activity stamp`,
      };
    }
    const at = opencodeActivityMs(dataDir);
    if (at === undefined || ctx.now - at < ctx.holdMs) {
      const age =
        at === undefined
          ? 'no provable activity stamp'
          : `last activity ${Math.round(Math.max(0, ctx.now - at) / 1000)}s ago`;
      return {
        active: true,
        detail: `${entries.length} opencode session(s) live outside this rig (pid ${entry.pid}) — ${age}`,
        activityAtMs: at,
      };
    }
  }
  return { active: false };
}

export const opencodeExternalPlane: ExternalActivityPlane = {
  kind: 'opencode',
  externalActivity: opencodeExternalActivity,
};

registerExternalPlane(opencodeExternalPlane);
