/** Gas City connector helpers. Kept separate so the harness facade stays focused on shared spawn policy. */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentState, AgentRegistryEntry, SpawnSpec } from '@broject/core';
import { LEARN_RETRO_CLOSEOUT } from '@broject/loop';
import * as harness from './spawn-harness.ts';

/** Factory-level probe — requires an actual city.toml (the authored
 *  city marker) so resolution prefers native when no Gas City exists,
 *  and gcMatchDir is exportable without forcing construction. */
export function gcMatchDir(dir: string, env: harness.AgentConnectorEnv): boolean {
  const city = gcConfigDir(dir, env);
  return city !== null && existsSync(join(city, 'city.toml'));
}

export interface GcRunOptions {
  args: string[];
  timeoutMs?: number;
}

export function gcRun({ args, timeoutMs = 30_000 }: GcRunOptions): {
  code: number;
  out: string;
  err: string;
} {
  const proc = spawnSync('gc', args, {
    // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  };
}

/** gc failure detail — stderr when the run wrote any, else the bare
 *  exit code. Shared so the failure messages below stay flat
 *  templates. */
export const gcErr = (r: { code: number; err: string }): string =>
  r.err !== '' ? r.err : `exited ${r.code}`;

/** `gc session list` row — only the fields this connector reads; the
 *  schema carries more (`gc session list --json-schema result`). */
export interface GcSession {
  id: string;
  alias?: string;
  state: string;
  closed?: boolean;
  work_dir?: string;
}

/** session list → (sessions, err). A parse failure IS a failed read. */
export function listGcSessions(city: string): { sessions?: GcSession[]; err?: string } {
  const r = gcRun({ args: ['session', 'list', '--json', '--state', 'all', '--city', city] });
  if (r.code !== 0) {
    return { err: r.err !== '' ? r.err : `gc session list exited ${r.code}` };
  }
  try {
    const v = JSON.parse(r.out) as { ok?: boolean; sessions?: GcSession[]; error?: string };
    if (v.ok === false) {
      return { err: v.error ?? 'gc session list returned ok: false' };
    }
    return { sessions: Array.isArray(v.sessions) ? v.sessions : [] };
  } catch {
    return { err: 'gc session list returned unparseable JSON' };
  }
}

/** The session owned by a registry entry — the stored sessionId first,
 *  the molStep alias as the pre-patch fallback. */
export function gcSessionFor(
  entry: AgentRegistryEntry,
  molStep: string,
  sessions: GcSession[]
): GcSession | undefined {
  const sid = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
  return sessions.find(s => s.id === sid) ?? sessions.find(s => s.alias === molStep);
}

/** gc session state → AgentState. `closed` rows map regardless of the
 *  state string; unstarted-but-durable sessions are 'spawned'. */
export function gcState(s: GcSession): AgentState {
  if (s.closed === true || s.state === 'closed') {
    return 'exited';
  }
  switch (s.state) {
    case 'active':
      return 'running';
    case 'suspended':
      return 'stopped';
    default:
      return 'spawned';
  }
}

/** Supervisor reachability — the liveness oracle. Only `true` is proof
 *  of life: the probe failing, an `ok:false` payload, a missing field,
 *  or a verified-stopped supervisor all mean a missing session cannot be
 *  called `lost` — callers degrade on anything but `true`. */
export function gcSupervisorRunning(): boolean | undefined {
  const r = gcRun({ args: ['supervisor', 'status', '--json'] });
  if (r.code !== 0) {
    return undefined;
  }
  try {
    const v = JSON.parse(r.out) as { ok?: boolean; running?: boolean };
    return v.ok !== false && v.running === true ? true : undefined;
  } catch {
    return undefined;
  }
}

/** Directory that owns the shared store — the rig root. `beadsDir` is
 *  the resolved `.beads`, so its parent is the project gc must adopt. */
export function gcRigDirOf(spec: SpawnSpec): string {
  return dirname(spec.beadsDir);
}

/** TOML basic-string escapes that have a short form. */
export const TOML_SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\b': '\\b',
  '\f': '\\f',
};

/** TOML basic-string escape — quotes, backslashes, and EVERY control
 *  char (U+0000–U+001F, U+007F) — a raw CR or other control byte makes
 *  the generated config unparsable. */
export const tomlStr = (s: string): string =>
  s.replace(
    /[\x00-\x1f\x7f"\\]/g,
    ch => TOML_SHORT_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

/** gc session submit carries the prompt as a single argv element —
 *  Linux caps it at 128KiB (MAX_ARG_STRLEN); leave headroom for the
 *  rest of argv. */
export const GC_SUBMIT_PROMPT_MAX = 120_000;

export interface GcCityTomlOptions {
  provider: string;
  command: string;
}

export const GC_CITY_TOML = ({ provider, command }: GcCityTomlOptions): string =>
  `# authored by bro's gascity connector (bro-cduq) — regenerate by deleting
[workspace]
provider = "${provider}"

[providers.${provider}]
command = "${tomlStr(command)}"
prompt_mode = "none"
`;

export const GC_AGENT_TOML = `scope = "city"
wake_mode = "resume"
`;

export const GC_PROMPT_TEMPLATE = `You are a bro-managed worker in a Gas City session.

Work arrives as a bead routed to this session — its description is the
work order — plus a submitted message carrying the rendered prompt. Follow
it exactly: work in this session's work_dir, verify like CI, push, open
the PR. The beads store is the shared store (this rig is adopted) —
verdicts go through \`bd update\`/\`bd close\` on the routed bead.

${LEARN_RETRO_CLOSEOUT}
`;

/** City root — explicit `agents.gascity.configDir`, else the shared
 *  `<git-common-dir>/bro/gascity` (out of every worktree). */
export function gcConfigDir(dir: string, env: harness.AgentConnectorEnv): string | null {
  const k = env.agents['gascity']?.configDir;
  if (typeof k === 'string' && k.trim() !== '') {
    return isAbsolute(k) ? k : resolve(dir, k);
  }
  const home = harness.agentsHome(dir);
  return home === null ? null : dirname(home) + '/gascity';
}

/** The command a Gas City actually runs — `initCity` writes city.toml
 *  once and never rewrites, so for an existing city the EFFECTIVE
 *  provider command is the stored one, not today's config. Falls back
 *  to the configured command when no toml exists or it can't be read. */
export function gcEffectiveCommand(city: string | null, configured: string): string {
  if (city === null) {
    return configured;
  }
  try {
    const toml = readFileSync(join(city, 'city.toml'), 'utf8');
    const m = toml.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    if (m?.[1] !== undefined) {
      // tomlStr wrote it — the same escape contract reads it back
      return JSON.parse(`"${m[1]}"`) as string;
    }
  } catch {
    // unreadable/malformed toml → admit against the configured command
  }
  return configured;
}

/** gascity claims a configDir layout — an authored city.toml at the
 *  resolved configDir is the marker (spec: agents.gascity.configDir).
 *  Factory-level: resolution probes this without constructing. */

// --- docker --------------------------------------------------------------------
