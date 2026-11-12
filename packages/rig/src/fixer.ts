/**
 * Fixer bead plane — the persistent per-PR bead a drive fixer works
 * under, its `drive:pr:<n>` external-ref format, and the attempt
 * bookkeeping that dedups fixer rounds per (head, class). Moved from
 * `commands/drive.ts` in the fleet-lifecycle extraction (bro-jamp7):
 * the bead lifecycle and dedup records are engine state every surface
 * reads; the spawn ceremony that consumes them stays in the command
 * layer.
 */
import {
  patchAgentRegistry,
  type AgentRegistryEntry,
  type TaskRow,
  type TaskStore,
} from '@broject/core';

/** One persistent bead per PR — the fixer's molStep, so facade dedup
 *  and respawn (same agentId on rebind) come free. */
export const FIXER_LABEL = 'fixer';
export const fixerRef = (pr: number): string => `drive:pr:${pr}`;

/** The PR number a fixer bead's external_ref names — the inverse of
 *  fixerRef. Undefined for any other ref shape. */
export function fixerPrFromRef(ref: string | null | undefined): number | undefined {
  const m = /^drive:pr:(\d+)$/.exec(ref ?? '');
  return m === null ? undefined : Number(m[1]);
}

/** The open fixer bead for a PR — external_ref upsert across passes. */
export function fixerBeadFor(store: TaskStore, pr: number): TaskRow | undefined {
  const ref = fixerRef(pr);
  return store
    .list({ labels: [FIXER_LABEL], all: true })
    .find(r => r.external_ref === ref && r.status !== 'closed');
}

export function ensureFixerBead(
  store: TaskStore,
  pr: number,
  link: string,
  branch: string
): TaskRow {
  return (
    fixerBeadFor(store, pr) ??
    store.create({
      title: `review fixer — PR #${pr}`,
      description:
        `Spawned by \`bro drive\` — work the gate state on ${link} ` +
        `(branch \`${branch}\`): review threads, a conflict rebase, ` +
        `failing checks, or SAST findings — whichever the spawn prompt ` +
        `orders. Push, never merge.`,
      type: 'task',
      labels: [FIXER_LABEL],
      externalRef: fixerRef(pr),
    })
  );
}

interface FixerAttempt {
  head: string;
  spent: string[];
  current: string;
}

function fixerAttemptOf(entry: AgentRegistryEntry | undefined): FixerAttempt | undefined {
  const v = entry?.fixerAttempt;
  if (typeof v !== 'object' || v === null) {
    return undefined;
  }
  const a = v as Partial<FixerAttempt> & { classes?: unknown };
  const strings = (xs: unknown): string[] =>
    Array.isArray(xs) ? xs.filter((c): c is string => typeof c === 'string') : [];
  if (typeof a.head !== 'string') {
    return undefined;
  }
  if (Array.isArray(a.spent) && typeof a.current === 'string') {
    return { head: a.head, spent: strings(a.spent), current: a.current };
  }
  // pre-split shape {head, classes} — every class shared the entry's
  // one cause; its best reading is 'all spent iff the cause was ok'
  if (Array.isArray(a.classes)) {
    return { head: a.head, spent: entry?.cause === 'ok' ? strings(a.classes) : [], current: '' };
  }
  return undefined;
}

/** The dedup verdict: this (head, class) already ran a fixer that
 *  exited clean — the same prompt on the same head is deterministic
 *  replay. A class is spent when its own ok exit promoted it into
 *  `spent`, or it's the entry's `current` class and `cause` reads
 *  'ok' (the connector harvests cause at .exit time): only 'ok' is a
 *  deliberated verdict — crash/lost/unclassified exits keep respawn
 *  semantics, and rate_limited/quota are refused downstream by the
 *  spawn guard. `stopped` lifts the dedup like it lifts a budget
 *  wall — `bro agents down` is the operator's manual clear. */
export function fixerAttemptSpent(
  entry: AgentRegistryEntry | undefined,
  head: string,
  cls: string
): boolean {
  if (entry === undefined || entry.stopped === true) {
    return false;
  }
  const a = fixerAttemptOf(entry);
  if (a?.head !== head) {
    return false;
  }
  return a.spent.includes(cls) || (a.current === cls && entry.cause === 'ok');
}

/** Stamp the attempt on the fixer bead's entry — runs inside the
 *  spawn's locked section right after the spawn write (the lock is
 *  re-entrant; the patch merges so connector fields survive).
 *  `prevEntry` is the entry read BEFORE `spawnStepAgent` reset
 *  `cause` — the run that just finished promotes its `current` class
 *  into `spent` iff that cause was 'ok'; a crashed class stays
 *  respawn-able, which is the whole point of tracking per class. */
export function recordFixerAttempt(
  dir: string,
  molStep: string,
  prevEntry: AgentRegistryEntry | undefined,
  head: string,
  cls: string
): void {
  const prev = fixerAttemptOf(prevEntry);
  const sameHead = prev?.head === head && prevEntry?.stopped !== true;
  const spent = sameHead ? [...(prev?.spent ?? [])] : [];
  if (
    sameHead &&
    prevEntry?.cause === 'ok' &&
    prev !== undefined &&
    prev.current !== '' &&
    !spent.includes(prev.current)
  ) {
    spent.push(prev.current);
  }
  patchAgentRegistry(dir, molStep, { fixerAttempt: { head, spent, current: cls } });
}
