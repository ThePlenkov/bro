/** In-process adapter session planes — the `SessionPlane.detectHook` /
 *  `normalizeHook` members the fleet epic sketched and bro-izpyk.9 lands
 *  (specs/bro-izpyk.9.md; epic `specs/sessions/bro-izpyk.md` SessionPlane
 *  sketch).
 *
 *  opencode, kilo, pi and omp run hooks IN-PROCESS — they spawn
 *  `bro hooks <event>` themselves and never touch hooks/run.sh, so the
 *  Tier-0 spool writer there never sees them. Each stamps
 *  `BRO_HOOK_HOST=<kind>` on the spawn env; `detectHook` is that marker's
 *  identity check. `bro hooks` emits the same v2 spool pair run.sh
 *  writes when a registered plane claims the launch — the ledger's
 *  drain, killed synthesis and session upserts all work unchanged.
 *
 *  The planes are deliberately degenerate like resume.ts's: `detectsCli`
 *  never claims a command and `countLive` throws 'unavailable' — they
 *  exist only to carry the hook seam. Registration MERGES into an
 *  existing plane (opencode already owns a resumeArgv plane via
 *  resume.ts) so either import order preserves every member. */
import {
  normalizeHookPayload,
  registerSessionPlane,
  sessionPlane,
  SpawnError,
  type SessionPlane,
} from '@broject/core';

/** The hosts that spawn `bro hooks` directly — the adapter kind names
 *  are the `BRO_HOOK_HOST` values their plugin files stamp. */
const IN_PROCESS_HOOK_KINDS = ['opencode', 'kilo', 'pi', 'omp'] as const;

function adapterPlane(kind: string): SessionPlane {
  return {
    kind,
    detectsCli: () => false,
    countLive() {
      throw new SpawnError(
        `${kind} sessions are not countable — in-process adapter plane`,
        'unavailable'
      );
    },
    detectHook: env => env.BRO_HOOK_HOST === kind,
    normalizeHook: payload => normalizeHookPayload(payload),
  };
}

for (const kind of IN_PROCESS_HOOK_KINDS) {
  const existing = sessionPlane(kind);
  const own = adapterPlane(kind);
  // merge, never replace — a real plane already owning the kind keeps
  // every member it declared; we only add the hook seam
  registerSessionPlane(
    existing === undefined
      ? own
      : { ...existing, detectHook: own.detectHook, normalizeHook: own.normalizeHook }
  );
}
