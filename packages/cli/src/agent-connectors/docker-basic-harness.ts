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

/** Index after the `// …` comment starting at i (no newline consumed). */
export function jsoncSkipLineComment(text: string, i: number): number {
  let k = i;
  while (k < text.length && text[k] !== '\n') {
    k++;
  }
  return k;
}

/** Index after the `/* … *\/` comment starting at i. */
export function jsoncSkipBlockComment(text: string, i: number): number {
  let k = i + 2;
  while (k < text.length && !(text[k] === '*' && text[k + 1] === '/')) {
    k++;
  }
  return Math.min(k + 2, text.length);
}

/** Whitespace AND comments — the trivia a trailing-comma lookahead
 *  skips: `{a:1, /* c *\/ }` is legal JSONC, so a `}` may hide behind
 *  a comment, not just whitespace. */
export function jsoncSkipTrivia(text: string, i: number): number {
  let k = i;
  for (;;) {
    while (k < text.length && /\s/.test(text[k]!)) {
      k++;
    }
    if (text[k] === '/' && text[k + 1] === '/') {
      k = jsoncSkipLineComment(text, k);
    } else if (text[k] === '/' && text[k + 1] === '*') {
      k = jsoncSkipBlockComment(text, k);
    } else {
      return k;
    }
  }
}

/** Copy the string literal starting at i verbatim — escapes included —
 *  into out; returns the index after its closing quote. A `//` or a
 *  `,]` inside a string is content, never comment or comma. */
export function jsoncCopyString(text: string, i: number, out: string[]): number {
  out.push('"'); // the opening quote — closing-quote detection starts one char in
  let k = i + 1;
  while (k < text.length) {
    const c = text[k]!;
    out.push(c);
    k++;
    if (c === '\\' && k < text.length) {
      out.push(text[k]!);
      k++;
    } else if (c === '"') {
      return k;
    }
  }
  return k;
}

/** devcontainer.json is commented JSON — // and /* … *\/ comments plus
 *  trailing commas are legal there and illegal to JSON.parse. The
 *  scanner copies significant chars only, tracking string state so a
 *  `//` inside a URL or a `,]` inside a string survives verbatim. */
export function jsoncToJson(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i = jsoncCopyString(text, i, out);
    } else if (c === '/' && text[i + 1] === '/') {
      i = jsoncSkipLineComment(text, i);
    } else if (c === '/' && text[i + 1] === '*') {
      i = jsoncSkipBlockComment(text, i);
    } else if (c === ',' && ['}', ']'].includes(text[jsoncSkipTrivia(text, i + 1)] ?? '')) {
      i++;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/** `agents.docker.runArgs` — array preferred; a string splits on
 *  whitespace (operator config, never user input). */
export function dockerRunArgs(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x !== '');
  }
  return typeof v === 'string' ? v.split(/\s+/).filter(s => s !== '') : [];
}
