/** Resume-only session planes — the `SessionPlane.resumeArgv`
 *  members the fleet epic's F4 needs (specs/sessions/bro-izpyk.md
 *  "Sessions and resume"; impl specs/bro-izpyk.4.md).
 *
 *  The ledger's `host` column names the four manifest hosts run.sh can
 *  prove (claude|codex|cursor|devin — hookHostOf's non-'unknown'
 *  answers) plus 'unknown'. `devin` already has a full quota plane in
 *  `@broject/devin`; this module registers MINIMAL planes for the other
 *  three manifest hosts plus opencode (whose plugin-host sessions can
 *  still appear in the ledger when a host spools them) so
 *  `sessionPlane(host).resumeArgv` answers for every resumable host.
 *
 *  A minimal plane is deliberately degenerate: `detectsCli` never
 *  claims a command and `countLive` throws SpawnError('unavailable')
 *  — it exists ONLY to carry resumeArgv. The quota paths can never
 *  reach it: sessionKindOf resolves a kind through detectsCli (never
 *  matches) or an explicit `agents.<backend>.sessionKind` declaration,
 *  and a declared kind armed with `agents.<kind>.max*` fails closed on
 *  the 'unavailable' count — the same refusal an unregistered kind
 *  gives, never a silent unguard. `listLive`/`countWorkers`/
 *  `countBatchWorkers` stay absent so boards and worker splits are
 *  untouched.
 *
 *  Importing this module registers the planes (and `@broject/devin`
 *  registers its own) — every `bro sessions`/`bro fleet resume`
 *  surface that renders a resume command imports it for the side
 *  effect, so the registry is populated on the read path. */
import { registerSessionPlane, sessionPlane, SpawnError, type SessionPlane } from '@broject/core';
// side effect: registers devinSessionPlane (quota plane + resumeArgv)
import '@broject/devin';

/** The argv each host's own CLI documents for reopening a session by
 *  its native id. Verified against current host docs: claude
 *  `--resume`, codex `resume`, opencode `--session` (NOT a `resume`
 *  subcommand — that spelling does not exist), cursor's `agent`
 *  binary `--resume` (`cursor-agent` is the legacy alias). A host
 *  absent from this table has no resume command bro knows — callers
 *  report that instead of guessing. */
const RESUME_ARGV: Record<string, (sid: string) => string[]> = {
  claude: sid => ['claude', '--resume', sid],
  codex: sid => ['codex', 'resume', sid],
  opencode: sid => ['opencode', '--session', sid],
  cursor: sid => ['agent', '--resume', sid],
};

function resumeOnlyPlane(kind: string, argv: (sid: string) => string[]): SessionPlane {
  return {
    kind,
    detectsCli: () => false,
    countLive() {
      throw new SpawnError(`${kind} sessions are not countable — resume-only plane`, 'unavailable');
    },
    resumeArgv: sid => argv(sid),
  };
}

for (const [kind, argv] of Object.entries(RESUME_ARGV)) {
  const existing = sessionPlane(kind);
  if (existing === undefined) {
    registerSessionPlane(resumeOnlyPlane(kind, argv));
  } else if (existing.resumeArgv === undefined) {
    // A real plane already owns this kind (a plugin quota plane that
    // beat us to registration) — AUGMENT it with resumeArgv rather
    // than replace it: every member the plane owns (countLive,
    // listLive, detectsCli, …) must survive. Its own resumeArgv, when
    // present, wins — the owner of the kind owns its resume grammar.
    registerSessionPlane({
      ...existing,
      resumeArgv: (sid, _cwd) => argv(sid),
    });
  }
}

/** The resume argv for a ledger session — the plane's answer, or null
 *  when the host has no registered plane or the plane declares no
 *  resume command. Never guesses: an unknown host is null, and the
 *  caller reports "no resume command" (spec: report, don't fabricate).
 *  `cwd` is the session's recorded working directory — passed through
 *  for hosts whose grammar scopes resume to it. */
export function sessionResumeArgv(host: string, sid: string, cwd: string): string[] | null {
  return sessionPlane(host)?.resumeArgv?.(sid, cwd) ?? null;
}
