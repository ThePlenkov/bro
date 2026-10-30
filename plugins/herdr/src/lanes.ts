/**
 * lanes — the daemon projector's per-worktree verdict read straight
 * off the fleet-status docs (spec bro-l8wqu). The projector is the
 * only classifier: `lane: 'acp'` when the session-owning agent's
 * provider resolves `type === 'acp'`; absent means the interactive /
 * fallback set. A missing or torn doc is "not yet classified" — the
 * workspace takes the fallback set and converges to the acp set on
 * the pass the doc lands (the doc write moves the diff key).
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type Lane = 'acp';

/** worktree path → 'acp' for every fleet-status doc carrying the
 *  verdict. Keys carry the doc's spelling plus its realpath so either
 *  side of a symlinked path still resolves. */
export function lanesRead(common: string): Record<string, Lane> {
  const out: Record<string, Lane> = {};
  let files: string[];
  try {
    files = readdirSync(join(common, 'bro', 'fleet-status')).filter(f => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(common, 'bro', 'fleet-status', f), 'utf8')) as {
        worktree?: unknown;
        lane?: unknown;
      };
      if (typeof d.worktree !== 'string' || d.lane !== 'acp') continue;
      out[d.worktree] = 'acp';
      try {
        out[realpathSync(d.worktree)] = 'acp';
      } catch {
        // unresolved spelling — the doc's own key still lands
      }
    } catch {
      // torn write — the next pass reads the landed doc
    }
  }
  return out;
}

/** The lane one armed worktree resolves to — 'acp' or nothing. */
export function laneOf(lanes: Record<string, Lane>, path: string): Lane | undefined {
  return lanes[path];
}
