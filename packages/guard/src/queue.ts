/**
 * The queued verdict plane (spec: specs/bro-36sx7.4.md) — a hook event
 * never runs the model: the guard judge facade consumes a landed
 * verdict or files a request and abstains, and a detached
 * `bro guard eval` drains requests against the real facade and
 * publishes verdicts back for the NEXT event's claim.
 *
 * Layout under `<git-common>/bro/judge/guard/` — the common git dir so
 * linked worktrees share the queue:
 *   <guard>.req.json            — the pending decide (state + questions)
 *   <guard>.req.json.work-<pid> — a drain's rename-claim
 *   <guard>.verdict.json        — the published DecideResult, claimed once
 *   .spawn                      — repo-level stamp throttling eval spawns
 *
 * Every op is tmp+rename or rename-claim; a torn, absent, or corrupt
 * entry degrades to abstain. A wedged drain leaks a work file — the
 * sweep reaps it and the req re-queues on the next decide.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GIT_SYNC_PROBE_TIMEOUT_MS,
  gitCommonDir,
  spawnSelf,
  type DecideResult,
  type JudgeFacade,
  type JudgeQuestion,
} from '@broject/core';

/** How long the .spawn stamp suppresses another eval spawn — longer
 *  than a drain pass so concurrent decides share one worker, short
 *  enough that a wedged worker re-arms on a later decide. */
const SPAWN_STAMP_MS = 60_000;
/** Entries past this are debris — work rinds, consumed-verdict shells,
 *  requests a dead worker never drained, verdicts of removed guards. */
const QUEUE_STALE_MS = 3_600_000;

/** `as const` objects satisfy JudgeQuestion at the type level but the
 *  queue is JSON — the wire shape is the same object. */
interface JudgeReq {
  state: unknown;
  questions: Record<string, JudgeQuestion>;
}

const safe = (name: string): string => name.replace(/[^\w.-]/g, '_');

/** `<git-common>/bro/judge/guard` — sibling of the verdicts journal.
 *  Null outside a repository (the facade then abstains outright). */
export function judgeQueueDir(dir: string): string | null {
  const common = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return common === null ? null : join(common, 'bro', 'judge', 'guard');
}

/** Rename-claim + read + rm — exactly one caller consumes the file; a
 *  racer gets ENOENT on the rename and falls through to re-queueing. */
function claimFile(path: string): string | null {
  const claimed = `${path}.seen-${process.pid}`;
  try {
    renameSync(path, claimed);
  } catch {
    return null;
  }
  try {
    return readFileSync(claimed, 'utf8');
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

const fresh = (path: string, ms: number): boolean => {
  try {
    return Date.now() - statSync(path).mtimeMs < ms;
  } catch {
    return false;
  }
};

function touch(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${Date.now()}\n`);
  } catch {
    // the stamp is a throttle, not a lock — a failed write only means
    // the next decide may also spawn
  }
}

const QUEUED: DecideResult = { answers: {}, model: 'queued', latencyMs: 0, lowConfidence: [] };

/** The hook-path judge facade (bro-36sx7.4): decide() first claims a
 *  verdict a drain already published for this guard — the engine
 *  reads it exactly like a live call, journal included — otherwise it
 *  files `<guard>.req.json`, kicks the throttled `bro guard eval`
 *  spawn, and abstains with an empty answer set (the engine's
 *  "no noul answer" row). No model call, no wait — a few fs ops. */
export function queuedJudge(dir: string): JudgeFacade {
  const root = judgeQueueDir(dir);
  return {
    async decide(state, questions) {
      const name =
        typeof state === 'object' && state !== null
          ? (state as { guard?: unknown }).guard
          : undefined;
      if (root === null || typeof name !== 'string' || safe(name) === '') {
        return QUEUED;
      }
      const verdict = claimFile(join(root, `${safe(name)}.verdict.json`));
      if (verdict !== null) {
        try {
          return JSON.parse(verdict) as DecideResult;
        } catch {
          // a corrupt verdict is no answer — re-queue below
        }
      }
      const req = join(root, `${safe(name)}.req.json`);
      try {
        mkdirSync(root, { recursive: true });
        const tmp = `${req}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify({ state, questions } satisfies JudgeReq));
        renameSync(tmp, req);
      } catch {
        return QUEUED;
      }
      const stamp = join(root, '.spawn');
      if (!fresh(stamp, SPAWN_STAMP_MS)) {
        touch(stamp);
        spawnSelf(['guard', 'eval'], dir);
      }
      return QUEUED;
    },
  };
}

/** The `bro guard eval` worker body — claim every pending request,
 *  decide against the real facade, publish the DecideResult to the
 *  guard's verdict file, remove the request. A thrown decide restores
 *  the req (the original write's mtime survives the renames, so its
 *  age is the retry backoff); a corrupt one is dropped. Returns the
 *  count drained — CLI exits 0 regardless; a quiet queue is success. */
export async function drainJudgeRequests(dir: string, facade: JudgeFacade): Promise<number> {
  const root = judgeQueueDir(dir);
  if (root === null) {
    return 0;
  }
  sweepQueue(root);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let drained = 0;
  for (const f of names) {
    if (!f.endsWith('.req.json')) {
      continue;
    }
    const req = join(root, f);
    const work = `${req}.work-${process.pid}`;
    try {
      renameSync(req, work);
    } catch {
      continue; // a peer drain claimed it
    }
    let payload: Partial<JudgeReq>;
    try {
      payload = JSON.parse(readFileSync(work, 'utf8')) as Partial<JudgeReq>;
    } catch {
      rmSync(work, { force: true });
      continue;
    }
    if (payload.state === undefined || payload.questions === undefined) {
      rmSync(work, { force: true });
      continue;
    }
    try {
      const res = await facade.decide(payload.state, payload.questions);
      const verdict = join(root, f.slice(0, -'.req.json'.length) + '.verdict.json');
      const tmp = `${verdict}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(res));
      renameSync(tmp, verdict);
      rmSync(work, { force: true });
      drained += 1;
    } catch {
      // no verdict produced — restore the req; its age throttles the
      // re-drain on a persistently-down judge
      try {
        renameSync(work, req);
      } catch {
        rmSync(work, { force: true });
      }
    }
  }
  return drained;
}

/** Reap queue debris — work/seen/tmp rinds past the spawn window (a
 *  live claim is seconds old at most; a rind outliving it is dead) and
 *  anything past the stale window. Runs on the drain path (a spawned
 *  worker), never on the hook's. */
function sweepQueue(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const stale = Date.now() - QUEUE_STALE_MS;
  const dead = Date.now() - SPAWN_STAMP_MS;
  for (const f of names) {
    const rind = /\.(work|seen|tmp)-\d+$/.test(f);
    const p = join(root, f);
    try {
      if (statSync(p).mtimeMs < (rind ? dead : stale)) {
        rmSync(p, { force: true });
      }
    } catch {
      // raced removal — the next drain sweeps it
    }
  }
}
