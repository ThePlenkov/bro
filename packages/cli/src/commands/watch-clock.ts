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
import { ghTryAsync } from '@broject/core';

/** |remote − local| past this and a reported time can be impossible —
 *  the tick's stamps are flagged, not trusted. */
export const CLOCK_SKEW_MS = 60_000;

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
  for (const line of out.split('\n')) {
    if (line.trim() === '') {
      return undefined;
    }
    const m = /^date:\s*(.+?)\s*$/i.exec(line);
    if (m !== null) {
      return m[1];
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

/** One tick's clock check. The probe exists only while a github
 *  reviews connector is serving — a non-gh host has no gh clock to
 *  check, so `clock` stays absent rather than failing every tick.
 *  `host.name` is set only when the facade AND repo resolved, so a
 *  dead `gh` never spawns a doomed probe. The probe itself is a seam —
 *  production rides `gh api / --include` with cwd=dir (gh resolves the
 *  API host off the repo's remotes — a GHES rig's clock comes from its
 *  own server). */
export async function clockPlane(
  dir: string,
  host: { name?: string },
  probe: ClockProbe = () => ghTryAsync(['api', '/', '--include'], dir),
  now: number = Date.now()
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
  const { skewMs, skewed } = clockVerdict(now, remoteMs);
  return { local, remote: new Date(remoteMs).toISOString(), skewMs, skewed };
}
