/**
 * The clock plane — `bro watch` stamps every tick from Date.now(), a
 * value only the local wall clock vouches for. bro-i7t3b: a watcher on
 * synthetic context reported merges at impossible future times because
 * nothing ever checked a tick against an external clock. When the
 * serving reviews connector is github, `gh api / --include` answers
 * with the host's own HTTP `Date` header — the external authority the
 * local clock is diffed against. Past CLOCK_SKEW_MS the tick's stamps
 * are unverifiable; a failed probe lands as `error` — unverified,
 * never a fabricated remote.
 */
import { execFileSync } from 'node:child_process';
import { GIT_REPO_ENV, ghTryAsync, gitBin } from '@broject/core';

/** |remote − local| past this and a reported time can be impossible —
 *  the tick's stamps are flagged, not trusted. */
export const CLOCK_SKEW_MS = 60_000;

/** The probe's own deadline — strictly below CLOCK_SKEW_MS so a slow
 *  response cannot age past the skew bound between the local sample and
 *  the verdict (a 60s+ late answer would read as skew even on aligned
 *  clocks), and a stalled `gh` never holds the pulse lock open. */
export const CLOCK_PROBE_TIMEOUT_MS = 45_000;

export interface WatchClock {
  /** Date.now() at probe time — the tick's own clock reading. */
  local: string;
  /** the review host's HTTP Date header — the external authority. */
  remote?: string;
  /** remote − local in ms; + means the local clock runs behind. */
  skewMs?: number;
  /** |skewMs| > CLOCK_SKEW_MS — reported times are unverifiable. */
  skewed: boolean;
  /** the probe failed — the clock is unverified, never silently trusted. */
  error?: string;
}

/** The `Date:` response header out of `gh api --include` output —
 *  header block only: below the first blank line a body field could
 *  carry the same name. */
export function dateHeader(out: string): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') {
      return undefined;
    }
    const m = /^date:(.*)$/i.exec(line);
    if (m !== null && m[1].trim() !== '') {
      return m[1].trim();
    }
  }
  return undefined;
}

export function clockVerdict(
  localMs: number,
  remoteMs: number
): { skewMs: number; skewed: boolean } {
  const skewMs = remoteMs - localMs;
  return { skewMs, skewed: Math.abs(skewMs) > CLOCK_SKEW_MS };
}

/** `+135s` / `-90s` — the signed seconds form attention lines carry. */
export function clockSkewText(skewMs: number): string {
  const s = Math.round(skewMs / 1000);
  return `${s >= 0 ? '+' : ''}${s}s`;
}

type ClockProbe = () => Promise<{ code: number; out: string; err: string }>;

/** `gh api` does NOT resolve its host off the repo's remotes — without
 *  GH_HOST it defaults to github.com, so a GHES rig would diff its clock
 *  against the wrong server (bro-13pdn). When origin parses to a host,
 *  pin it explicitly. */
function clockProbeArgs(dir: string): string[] {
  const args = ['api', '/', '--include'];
  try {
    const out = execFileSync(gitBin(), ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubGitEnv(),
      // a cred-helper or transport stall must never freeze the loop —
      // the probe budget already pins 45s, this lookup gets a fraction
      timeout: 5_000,
    });
    const host = remoteHost(out);
    if (host !== undefined) {
      args.push('--hostname', host);
    }
  } catch {
    // no origin / not a repo — gh's own default resolution applies
  }
  return args;
}

function scrubGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of GIT_REPO_ENV) {
    delete env[k];
  }
  return env;
}

/** One tick's clock check. The probe exists only while a github
 *  reviews connector is serving — a non-gh host has no gh clock to
 *  check, so `clock` stays absent rather than failing every tick.
 *  `host.name` is set only when the facade AND repo resolved, so a
 *  dead `gh` never spawns a doomed probe. The probe itself is a seam —
 *  production rides `gh api / --include` with cwd=dir (gh resolves the
 *  API host off the repo's remotes — a GHES rig's clock comes from its
 *  own server). */
/** The serving host out of the origin remote — https and ssh forms.
 *  Undefined when no remote parses: the probe then falls back to gh's
 *  own default resolution. */
export function remoteHost(url: string): string | undefined {
  const u = url.trim();
  if (/^https?:\/\//.test(u)) {
    // URL parsing keeps userinfo out — https://token@github.com/o/r.git
    // must yield github.com, never token@github.com
    try {
      return new URL(u).hostname;
    } catch {
      return undefined;
    }
  }
  const m = /^(?:ssh:\/\/git@|git@)([^/:]+)/.exec(u);
  return m?.[1];
}

export async function clockPlane(
  dir: string,
  host: { name?: string },
  probe: ClockProbe = () => ghTryAsync(clockProbeArgs(dir), dir, CLOCK_PROBE_TIMEOUT_MS),
  now: number = Date.now(),
  /** the local sample AFTER the probe resolves — the flight-time half
   *  of the uncertainty interval; a seam so tests control both ends */
  after: number | undefined = undefined
): Promise<WatchClock | undefined> {
  if (host.name !== 'github') {
    return undefined;
  }
  const local = new Date(now).toISOString();
  let res: { code: number; out: string; err: string };
  try {
    res = await probe();
  } catch (err) {
    return { local, skewed: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.code !== 0) {
    return {
      local,
      skewed: false,
      error: res.err !== '' ? res.err : `gh api exited ${res.code}`,
    };
  }
  const header = dateHeader(res.out);
  if (header === undefined) {
    return { local, skewed: false, error: 'gh api response carried no Date header' };
  }
  const remoteMs = Date.parse(header);
  if (!Number.isFinite(remoteMs)) {
    return { local, skewed: false, error: `unparseable Date header — ${header}` };
  }
  // `now` was sampled BEFORE the probe; the Date header stamps the
  // response — up to the full probe duration plus one second of header
  // precision later. The true skew is an interval, not a point: when
  // that interval straddles the bound the tick is unverified — a slow
  // probe must not launder a real skew under the line, nor invent one
  // (bro-4xxve)
  const afterMs = after ?? Date.now();
  const lo = remoteMs - afterMs; // kindest reading: instant probe, latest remote tick
  const hi = remoteMs + 1000 - now; // worst: full probe flight + header precision
  if (Math.abs(lo) <= CLOCK_SKEW_MS && Math.abs(hi) <= CLOCK_SKEW_MS) {
    const { skewMs, skewed } = clockVerdict(now, remoteMs);
    return { local, remote: new Date(remoteMs).toISOString(), skewMs, skewed };
  }
  if (lo > CLOCK_SKEW_MS || hi < -CLOCK_SKEW_MS) {
    // the whole interval sits past the bound — skew regardless of flight time
    const { skewMs, skewed } = clockVerdict(now, remoteMs);
    return { local, remote: new Date(remoteMs).toISOString(), skewMs, skewed };
  }
  return {
    local,
    remote: new Date(remoteMs).toISOString(),
    skewed: false,
    error: `probe uncertainty ±${Math.round((hi - lo) / 1000)}s straddles the skew bound — unverified`,
  };
}
