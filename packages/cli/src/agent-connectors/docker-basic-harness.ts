/** Basic Docker command and descriptor helpers. */
import { spawnSync } from 'node:child_process';
import type { AgentRegistryEntry } from './spawn-harness.ts';

/** One docker call — PATH lookup is the same contract as git/gh/bd. */

export interface DockerRunOptions {
  args: string[];
  timeoutMs?: number;
}

export function dockerRun({ args, timeoutMs = 30_000 }: DockerRunOptions): {
  code: number;
  out: string;
  err: string;
  missing: boolean;
} {
  const proc = spawnSync('docker', args, {
    // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
    missing: (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  };
}

/** Daemon reachability — `docker version` contacts the SERVER (a bare
 *  `docker --version` is client-only and would pass beside a dead
 *  daemon). */
export function dockerDaemonUp(): { up: boolean; err: string } {
  const v = dockerRun({ args: ['version', '--format', '{{.Server.Version}}'] });
  if (v.missing) {
    return { up: false, err: 'docker not on PATH' };
  }
  if (v.code !== 0) {
    return { up: false, err: v.err !== '' ? v.err : 'daemon unreachable' };
  }
  return { up: true, err: '' };
}

/** Running container names — one daemon round-trip batched across a
 *  registry walk. `undefined` = inconclusive (daemon down/refused);
 *  callers treat it as "may occupy" the same way tmux treats a failed
 *  list-sessions. bro's own label narrows the listing. */
export function dockerLiveContainers(): Set<string> | undefined {
  const ps = dockerRun({
    args: ['ps', '--filter', 'label=bro.managed=1', '--format', '{{.Names}}'],
  });
  return ps.code === 0 ? new Set(ps.out.split('\n').filter(s => s !== '')) : undefined;
}

/** docker-name charset — `bro-<agentId>` always passes; a tampered
 *  registry `container` must still prove safe before it becomes an
 *  inspect/rm operand. */
export const DOCKER_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The registry entry's container name — the recorded one, or derived
 *  from a safe agentId for entries written before `container` existed. */
export function dockerContainerName(entry: AgentRegistryEntry): string | undefined {
  if (typeof entry.container === 'string' && DOCKER_CONTAINER_NAME.test(entry.container)) {
    return entry.container;
  }
  const derived = `bro-${entry.agentId}`;
  return DOCKER_CONTAINER_NAME.test(derived) ? derived : undefined;
}

/** `Error response from daemon: No such container`/`No such object` —
 *  proof of a corpse (or a removed one), not an unreachable daemon. */
export const DOCKER_NO_SUCH = /no such (?:object|container)/i;

/** Tri-state liveness — 'running' proves life, 'dead' proves a corpse
 *  (`--rm` containers self-remove on exit, so dead IS absent; a
 *  present-but-stopped one reads the same either way). 'unknown' is a
 *  failed probe that must never read as dead. */
export type DockerLiveness = 'running' | 'dead' | 'unknown';

export interface DockerInspect {
  live: DockerLiveness;
  pid?: number;
  err?: string;
}

export interface DockerInspectOptions {
  name: string;
}

export function dockerInspect({ name }: DockerInspectOptions): DockerInspect {
  const r = dockerRun({
    args: ['inspect', '--type', 'container', '--format', '{{json .State}}', name],
  });
  if (r.code !== 0) {
    return {
      live: DOCKER_NO_SUCH.test(r.err) ? 'dead' : 'unknown',
      err: r.err !== '' ? r.err : `docker inspect exited ${r.code}`,
    };
  }
  try {
    const s = JSON.parse(r.out) as { Running?: unknown; Pid?: unknown };
    return {
      live: s.Running === true ? 'running' : 'dead',
      pid: typeof s.Pid === 'number' && s.Pid > 0 ? s.Pid : undefined,
    };
  } catch {
    return { live: 'unknown', err: 'docker inspect returned unparseable JSON' };
  }
}

export * from './docker-jsonc.ts';
/** `agents.docker.runArgs` — array preferred; a string splits on
 *  whitespace (operator config, never user input). */
export function dockerRunArgs(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x !== '');
  }
  return typeof v === 'string' ? v.split(/\s+/).filter(s => s !== '') : [];
}
