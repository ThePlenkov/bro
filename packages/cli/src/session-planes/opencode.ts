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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 *  `opencode` and argv[1] is not a non-session subcommand (`serve`
 *  hosts sessions but works none itself — counting it would hold the
 *  guard on infrastructure alone). A missing cmdline cannot prove
 *  session-ness — it does not count (an unverifiable proc undercounts,
 *  never invents a session). */
function opencodeSessionArgv(cmdline: string): boolean {
  const argv = cmdline.split('\0').filter(t => t !== '');
  if (basename(argv[0] ?? '') !== 'opencode') {
    return false;
  }
  return argv[1] !== 'serve' && argv[1] !== '--service';
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
    return opencodeSessionArgv(readFileSync(join(dir, 'cmdline'), 'utf8'));
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

/** One /proc entry's verdict — the pid when it is a live foreign
 *  opencode session, undefined otherwise. */
function foreignOpencodePid(procDir: string, name: string): number | undefined {
  const pid = liveNumericPid(name);
  const dir = join(procDir, name);
  if (pid === undefined || !opencodeSessionEntry(dir)) {
    return undefined;
  }
  return broOwnedEntry(dir) ? undefined : pid;
}

/** Live foreign opencode session pids — opencode argv, alive, and not
 *  bro-owned. An unreadable cmdline is skipped; an unreadable environ
 *  counts as external (ownership cannot be proven). An unreadable
 *  /proc root fails closed like the devin scan — SpawnError
 *  'unavailable' rather than pretending zero sessions. */
export function foreignOpencodePids(procDir = '/proc'): number[] {
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
  const pids: number[] = [];
  for (const name of names) {
    const pid = foreignOpencodePid(procDir, name);
    if (pid !== undefined) {
      pids.push(pid);
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
 *  hold window. The foreign set is what the count counts; the host's
 *  freshest stamp is the activity bound for all of them. */
export function opencodeExternalActivity(ctx: ExternalProbeCtx): ExternalActivity {
  const bag = ctx.agents['opencode'] ?? {};
  const pids = foreignOpencodePids(opencodeProcDir(bag));
  if (pids.length === 0) {
    return { active: false };
  }
  const at = opencodeActivityMs(opencodeDataDir(bag, ctx.env));
  if (at !== undefined && ctx.now - at >= ctx.holdMs) {
    return { active: false, activityAtMs: at };
  }
  const age =
    at === undefined
      ? 'no provable activity stamp'
      : `last activity ${Math.round(Math.max(0, ctx.now - at) / 1000)}s ago`;
  return {
    active: true,
    detail: `${pids.length} opencode session(s) live outside this rig (pid ${pids[0]}) — ${age}`,
    activityAtMs: at,
  };
}

export const opencodeExternalPlane: ExternalActivityPlane = {
  kind: 'opencode',
  externalActivity: opencodeExternalActivity,
};

registerExternalPlane(opencodeExternalPlane);
