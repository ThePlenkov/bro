/**
 * Exit-harvest learn/retro artifact check (spec bro-xkv42.2) — the
 * enforcement half of the learn-every-run epic: when `ensureExitCause`
 * classifies a worker's death, this asks whether the run left the
 * learn/retro evidence the epic requires. A proven-absent run is a
 * `miss` (flagged on the registry entry + a `learn-miss` lifecycle
 * row); an uninspectable one is `skipped`, never a false miss.
 *
 * Evidence contract (any one → 'ok'):
 *   1. a `learn:`/`learning:`-flagged close_reason — the run's bead,
 *      or every step of a molecule-root run via one `bd mol show`;
 *   2. a `learn/` kv lesson whose evidence refs intersect the run's id
 *      set inside the run window;
 *   3. a `retro`/`prevention` bead discovered-from the run's beads
 *      (bounded `discovered`-up walk through `wtf` intermediaries) or
 *      created inside the run window — `captureWtf` wires no dep to
 *      the work bead, so creation time is the only attribution the
 *      standard retro flow leaves.
 *
 * Skip gates: budget/auth walls and operator stops (the worker could
 * not have finished), remote lanes (copilot cannot reach the shared
 * dolt). Every probe is individually fail-open — a failure degrades
 * the verdict to 'skipped' with the plane named, never to 'miss' on
 * unproven absence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentLearnCheck,
  type AgentRegistryEntry,
  bdAt,
  beadsDir,
  beadsStoreStampAt,
  entryRunId,
  type TaskRow,
  taskStoreAt,
} from '@broject/core';
import { LEARN_FLAG, type Lesson, listLessonsAt } from '@broject/learn';

export interface LearnCheckResult {
  verdict: AgentLearnCheck;
  /** What satisfied the check (`ok`) or why it didn't run (`skipped`);
   *  absent on `miss` — the miss itself is the signal. */
  evidence?: string;
}

export interface LearnCheckOpts {
  /** The rig root the harvest runs against (registry/journal dir). */
  dir: string;
  /** The agents home (`<git-common>/bro/agents`) — the lesson-snapshot
   *  cache lives beside the run's other artifacts; null reads live. */
  home: string | null;
  molStep: string;
  entry: AgentRegistryEntry;
  /** The classified exit cause — wall causes skip before any store read. */
  cause: string;
  /** The .exit file's mtime (ms) — the honest death stamp the run
   *  window anchors on, so a lazy harvest still windows on the death. */
  exitAt: number;
}

/** Causes where absence of evidence proves nothing — the worker was
 *  prevented from doing useful work (the bead's budget-wall exclusion;
 *  `auth` is the same class of "could not work"). */
const SKIP_CAUSES: ReadonlySet<string> = new Set(['rate_limited', 'quota', 'auth']);

/** Backends whose workers cannot reach the shared dolt — their
 *  artifacts are uninspectable by construction, so the check skips
 *  rather than false-flag (copilot is the documented remote lane). */
const SKIP_BACKENDS: ReadonlySet<string> = new Set(['copilot']);

/** Bead labels that count as retro-pipeline evidence. */
const RETRO_LABELS: readonly string[] = ['retro', 'prevention'];
/** The `wtf` bead is the canonical intermediary: wtf → retro →
 *  prevention is the `bro retrospect` chain the dep walk expands. */
const WTF_LABEL = 'wtf';

/** Run window margins around [spawnedAt, exitAt]: the registry stamp
 *  precedes exec by seconds; a lesson kv write can land just after the
 *  .exit file. Both are generous — the window exists to keep a RESPAWN
 *  from inheriting the prior attempt's artifacts, not to be tight. */
const WINDOW_BEFORE_MS = 120_000;
const WINDOW_AFTER_MS = 300_000;

/** Dep-walk bounds — once per run, never per poll. `neighbors` is one
 *  `bd dep list` per target (multi-id `deps` up-queries return hydrated
 *  rows the edge-folder drops — the single-id row plane is the
 *  contract drill's priorPreventionRows already rides). */
const MAX_DEP_TARGETS = 8;
const MAX_WTF_EXPANSIONS = 4;

const hasLabel = (row: TaskRow, label: string): boolean =>
  Array.isArray(row.labels) && row.labels.includes(label);

/** Defensive timestamp read — bd emits `created_at`/`closed_at`;
 *  tolerate the camel spellings too. NaN = "can't disprove". */
const tsOf = (row: object | undefined, ...keys: string[]): number => {
  if (row === undefined) {
    return Number.NaN;
  }
  const rec = row as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) {
        return t;
      }
    }
  }
  return Number.NaN;
};

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface MolStepRow {
  id: string;
  title?: string;
  status?: string;
  close_reason?: string;
  closed_at?: string;
  created_at?: string;
}

interface MolShowPayload {
  root?: { id?: string; status?: string };
  issues?: MolStepRow[];
}

/** `bd mol show <id> --json` pinned to the shared store — the whole
 *  step DAG's close_reasons in one call (the bead's "one molecule
 *  show"). Throws on failure — the caller degrades. */
function molShow(beads: string, molId: string): MolShowPayload {
  const res = bdAt(beads, ['mol', 'show', molId, '--json']);
  if (res.code !== 0) {
    throw new Error(`bd mol show ${molId} failed (${res.code}): ${res.err || res.out.trim()}`);
  }
  try {
    return JSON.parse(res.out) as MolShowPayload;
  } catch (err) {
    throw new Error(`bd mol show ${molId} returned malformed JSON — ${msg(err)}`);
  }
}

const FLAGGED_LINE = (reason: unknown): boolean =>
  typeof reason === 'string' && reason.split('\n').some(l => LEARN_FLAG.test(l.trim()));

interface LessonCachePayload {
  stamp: string;
  beads: string;
  lessons: Lesson[];
}

/** The cache payload is THIS store's only when stamp AND beads path
 *  both match: two distinct stores can share a manifest stamp (fresh
 *  empty stores stamp identically), and only the path proves the
 *  lessons are THIS store's. */
const cacheIsFor = (v: unknown, stamp: string, beads: string): v is LessonCachePayload => {
  const c = v as Partial<LessonCachePayload> | null;
  return (
    c !== null &&
    typeof c === 'object' &&
    c.stamp === stamp &&
    c.beads === beads &&
    Array.isArray(c.lessons)
  );
};

/** The cached listing — stamp AND beads-path must match; a torn cache
 *  reads live, never a verdict input. */
function lessonsCacheRead(cachePath: string, stamp: string, beads: string): Lesson[] | undefined {
  if (!existsSync(cachePath)) {
    return undefined;
  }
  try {
    const cached: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cacheIsFor(cached, stamp, beads)) {
      return cached.lessons;
    }
  } catch {
    // a torn cache reads live — never a verdict input
  }
  return undefined;
}

/** Best-effort write — the cache is an optimization, not the
 *  contract; a failed write just reads live next check. */
function lessonsCacheWrite(cachePath: string, payload: LessonCachePayload): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(payload));
  } catch {
    // best effort — the cache is an optimization, not the contract
  }
}

/** The lesson kv listing, stamp-cached under the agents home — the
 *  same over-invalidation contract as the connector's snapshot: a
 *  store without a recognizable dolt layout yields no stamp and every
 *  check reads live (never a stale cache). The stamp keys the SAME
 *  `beads` path the listing reads — entry.storeDir can diverge from
 *  beadsDir(dir), and a stamp on the wrong store would serve another
 *  store's lessons. */
function lessonsCached(home: string | null, beads: string): Lesson[] {
  const stamp = beadsStoreStampAt(beads);
  if (home === null || stamp === null) {
    return listLessonsAt(beads).lessons;
  }
  const cachePath = join(home, 'learn-lessons.json');
  const hit = lessonsCacheRead(cachePath, stamp, beads);
  if (hit !== undefined) {
    return hit;
  }
  const { lessons } = listLessonsAt(beads);
  lessonsCacheWrite(cachePath, { stamp, beads, lessons });
  return lessons;
}

/** The run's evidence id set — session identities plus every bead the
 *  run can claim credit for (its step, the molecule, sibling steps on
 *  a root run). */
function runIds(
  entry: AgentRegistryEntry,
  molStep: string,
  molParent: string | undefined,
  stepIds: string[]
): Set<string> {
  const ids = new Set<string>([entry.agentId, molStep, ...stepIds]);
  const runId = entryRunId(entry);
  if (runId !== undefined) {
    ids.add(runId);
  }
  for (const key of ['session_id', 'acpSessionId'] as const) {
    const v = entry[key];
    if (typeof v === 'string' && v !== '') {
      ids.add(v);
    }
  }
  if (molParent !== undefined) {
    ids.add(molParent);
  }
  return ids;
}

/** Mutable walk state shared across a depWalkHit hop — the visited
 *  set, the frontier's wtf candidates, the degraded log, and the
 *  window predicate. */
interface DepWalk {
  seen: Set<string>;
  wtfNext: string[];
  degraded: string[];
  inWindow: (t: number) => boolean;
}

/** A retro/prevention-labeled row inside the window — an unparseable
 *  created stamp can't disprove, so NaN passes. */
const isRetroRow = (row: TaskRow, created: number, inWindow: (t: number) => boolean): boolean =>
  RETRO_LABELS.some(l => hasLabel(row, l)) && (Number.isNaN(created) || inWindow(created));

/** wtf rows expand only off the run's own frontier (hop 0) and only
 *  up to the bound — the one documented intermediary. */
const wtfExpandable = (row: TaskRow, hop: number, wtfNext: string[]): boolean =>
  hop === 0 && hasLabel(row, WTF_LABEL) && wtfNext.length < MAX_WTF_EXPANSIONS;

/** One frontier target's discovered-up neighbors: the retro hit, or
 *  the wtf rows queued for the next hop's expansion. A failed read
 *  records `degraded` and yields nothing — partial coverage never
 *  upgrades to 'miss'. */
function depNeighbors(
  store: ReturnType<typeof taskStoreAt>,
  target: string,
  hop: number,
  walk: DepWalk
): { id: string; via: string } | undefined {
  let rows: TaskRow[];
  try {
    rows = store.neighbors<TaskRow>(target, { direction: 'up', rel: 'discovered' });
  } catch (err) {
    walk.degraded.push(`dep list ${target}: ${msg(err)}`);
    return undefined;
  }
  for (const row of rows) {
    if (walk.seen.has(row.id)) {
      continue;
    }
    walk.seen.add(row.id);
    const created = tsOf(row, 'created_at', 'createdAt');
    if (isRetroRow(row, created, walk.inWindow)) {
      return { id: row.id, via: `discovered-from ${target}` };
    }
    if (wtfExpandable(row, hop, walk.wtfNext)) {
      walk.wtfNext.push(row.id);
    }
  }
  return undefined;
}

/** One hop's frontier sweep — every target's neighbors; a retro hit
 *  returns immediately, wtf rows queue for the next hop on
 *  walk.wtfNext. */
function walkHop(
  store: ReturnType<typeof taskStoreAt>,
  frontier: string[],
  hop: number,
  walk: DepWalk
): { id: string; via: string } | undefined {
  walk.wtfNext = [];
  for (const target of frontier) {
    const hit = depNeighbors(store, target, hop, walk);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Bounded `discovered`-up walk: run beads → (wtf) → retro/prevention.
 *  Every visited row is label-checked; only `wtf` rows expand (the one
 *  documented intermediary). A failed neighbor read records `degraded`
 *  and keeps walking what answered — partial coverage never upgrades
 *  to 'miss'. */
function depWalkHit(
  store: ReturnType<typeof taskStoreAt>,
  targets: string[],
  inWindow: (t: number) => boolean,
  degraded: string[]
): { id: string; via: string } | undefined {
  let frontier = targets.slice(0, MAX_DEP_TARGETS);
  const walk: DepWalk = { seen: new Set(frontier), wtfNext: [], degraded, inWindow };
  for (let hop = 0; hop < 2 && frontier.length > 0; hop++) {
    const hit = walkHop(store, frontier, hop, walk);
    if (hit !== undefined) {
      return hit;
    }
    frontier = walk.wtfNext;
  }
  return undefined;
}

/** `retro`/`prevention` rows created inside the run window — the
 *  attribution the orphan wtf→retro chain leaves (captureWtf wires no
 *  dep to the work bead). Two label lists, client-side window. A
 *  failed list records `degraded` and tries the other label. */
function windowRetroHit(
  store: ReturnType<typeof taskStoreAt>,
  inWindow: (t: number) => boolean,
  degraded: string[]
): { id: string; label: string } | undefined {
  for (const label of RETRO_LABELS) {
    let rows: TaskRow[];
    try {
      rows = store.list<TaskRow>({ labels: [label], all: true, limit: 0 });
    } catch (err) {
      degraded.push(`list -l ${label}: ${msg(err)}`);
      continue;
    }
    for (const row of rows) {
      const created = tsOf(row, 'created_at', 'createdAt');
      if (!Number.isNaN(created) && inWindow(created)) {
        return { id: row.id, label };
      }
    }
  }
  return undefined;
}

/** The once-per-run skip gates — cheapest first, no store reads.
 *  An operator-ended run (`agents down`) never reached its closeout —
 *  externally prevented like a wall, so absence proves nothing (the
 *  status path already returns 'stopped' before classify; this covers
 *  the unconditional harvest callers like budget walks). */
function skipVerdict(opts: LearnCheckOpts): LearnCheckResult | undefined {
  const { entry, cause } = opts;
  if (entry.stopped === true) {
    return {
      verdict: 'skipped',
      evidence: 'stopped — operator-ended run; the worker never reached closeout',
    };
  }
  if (SKIP_CAUSES.has(cause)) {
    return {
      verdict: 'skipped',
      evidence: `${cause} — provider/budget wall; the worker could not have worked`,
    };
  }
  if (SKIP_BACKENDS.has(entry.backend)) {
    return {
      verdict: 'skipped',
      evidence: `${entry.backend} — remote lane cannot reach the shared store`,
    };
  }
  return undefined;
}

/** The run window predicate — [spawnedAt-2m, exitAt+5m]; an
 *  unparseable spawn stamp anchors on the death instead, and an
 *  unparseable probe stamp can't disprove (`NaN` → in-window). */
function runWindow(exitAt: number, spawnedAt: unknown): (t: number) => boolean {
  const spawned = Date.parse(typeof spawnedAt === 'string' ? spawnedAt : '');
  const winStart = (Number.isFinite(spawned) ? spawned : exitAt) - WINDOW_BEFORE_MS;
  const winEnd = exitAt + WINDOW_AFTER_MS;
  return (t: number): boolean => Number.isNaN(t) || (t >= winStart && t <= winEnd);
}

/** The molecule's step rows — one `bd mol show` when the run's bead
 *  IS the molecule root; [] otherwise or on a degraded read. */
function molStepRows(beads: string, molStep: string, degraded: string[]): MolStepRow[] {
  try {
    const mol = molShow(beads, molStep);
    if (mol.root?.id === undefined || !Array.isArray(mol.issues)) {
      degraded.push(`mol show ${molStep}: unexpected shape`);
      return [];
    }
    return mol.issues.filter(i => i.id !== mol.root?.id);
  } catch (err) {
    degraded.push(msg(err));
    return [];
  }
}

/** The step row + molecule step rows every evidence probe shares —
 *  the run's bead context. Failed reads record `degraded` and yield
 *  partial context, never a verdict. */
function stepContext(
  store: ReturnType<typeof taskStoreAt>,
  beads: string,
  molStep: string,
  degraded: string[]
): { row: TaskRow | undefined; molParent: string | undefined; stepRows: MolStepRow[] } {
  let row: TaskRow | undefined;
  try {
    row = store.get<TaskRow>(molStep);
  } catch (err) {
    degraded.push(`show ${molStep}: ${msg(err)}`);
  }
  const molParent = typeof row?.parent === 'string' && row.parent !== '' ? row.parent : undefined;
  const stepRows = row?.issue_type === 'molecule' ? molStepRows(beads, molStep, degraded) : [];
  return { row, molParent, stepRows };
}

/** Evidence 1 — a learn:-flagged close_reason on the step or any
 *  molecule step, inside the run window. */
function flaggedCloseHit(
  row: TaskRow | undefined,
  stepRows: MolStepRow[],
  molStep: string,
  inWindow: (t: number) => boolean
): LearnCheckResult | undefined {
  if (FLAGGED_LINE(row?.close_reason) && inWindow(tsOf(row, 'closed_at', 'closedAt'))) {
    return { verdict: 'ok', evidence: `learn:-flagged close_reason on ${molStep}` };
  }
  for (const step of stepRows) {
    if (FLAGGED_LINE(step.close_reason) && inWindow(tsOf(step, 'closed_at', 'closedAt'))) {
      return {
        verdict: 'ok',
        evidence: `learn:-flagged close_reason on molecule step ${step.id}`,
      };
    }
  }
  return undefined;
}

/** Evidence 2's probe context — the lesson plane's shared inputs. */
interface LessonProbe {
  home: string | null;
  beads: string;
  ids: Set<string>;
  inWindow: (t: number) => boolean;
  degraded: string[];
}

/** Evidence 2 — a learn/ lesson whose evidence refs intersect the
 *  run's id set inside the window. */
function lessonHit(p: LessonProbe): LearnCheckResult | undefined {
  try {
    for (const lesson of lessonsCached(p.home, p.beads)) {
      if (!lesson.evidence.some(e => p.ids.has(e.ref))) {
        continue;
      }
      if (p.inWindow(Date.parse(lesson.updatedAt ?? lesson.createdAt))) {
        return { verdict: 'ok', evidence: `lesson ${lesson.id} cites this run` };
      }
    }
  } catch (err) {
    p.degraded.push(`kv list: ${msg(err)}`);
  }
  return undefined;
}

/** Evidence 3 — retro/prevention artifacts: the bounded discovered-up
 *  walk, then the creation-window list (the orphan wtf→retro chain's
 *  only attribution). The walkers guard their own probes — the catch
 *  is the never-throws contract's last wall, not an expected path. */
function retroHit(
  store: ReturnType<typeof taskStoreAt>,
  depTargets: string[],
  inWindow: (t: number) => boolean,
  degraded: string[]
): LearnCheckResult | undefined {
  try {
    const hit = depWalkHit(store, depTargets, inWindow, degraded);
    if (hit !== undefined) {
      return {
        verdict: 'ok',
        evidence: `retro/prevention bead ${hit.id} ${hit.via} (in run window)`,
      };
    }
    const retro = windowRetroHit(store, inWindow, degraded);
    if (retro !== undefined) {
      return {
        verdict: 'ok',
        evidence: `${retro.label} bead ${retro.id} created inside the run window`,
      };
    }
  } catch (err) {
    degraded.push(`retro probes: ${msg(err)}`);
  }
  return undefined;
}

/** The store the run answers evidence probes against — the spawn's
 *  verbatim spec.beadsDir pin, else the dir-resolved store; exotic
 *  non-string pins fall back the same way. */
const pinnedBeads = (entry: AgentRegistryEntry, dir: string): string | null => {
  const pinned = entry.storeDir;
  return typeof pinned === 'string' && pinned !== '' ? pinned : beadsDir(dir);
};

/** The dep-walk's seed set — the step, its molecule parent, and every
 *  sibling step row, deduped. */
const depTargetsFor = (
  molStep: string,
  molParent: string | undefined,
  stepRows: MolStepRow[]
): string[] => [
  ...new Set([
    molStep,
    ...(molParent === undefined ? [] : [molParent]),
    ...stepRows.map(s => s.id),
  ]),
];

/** The no-hit tail — degraded probes read 'skipped' (unproven
 *  absence), a clean sweep reads 'miss'. */
const degradedVerdict = (degraded: string[]): LearnCheckResult =>
  degraded.length > 0
    ? { verdict: 'skipped', evidence: `probes failed — ${degraded.join('; ')}` }
    : { verdict: 'miss' };

/** The once-per-run artifact verdict. Never throws — the harvest it
 *  rides must not fail on a learn-store problem. */
export function checkRunLearnEvidence(opts: LearnCheckOpts): LearnCheckResult {
  const skip = skipVerdict(opts);
  if (skip !== undefined) {
    return skip;
  }
  const { dir, home, molStep, entry, exitAt } = opts;
  const beads = pinnedBeads(entry, dir);
  if (beads === null) {
    return { verdict: 'skipped', evidence: 'no beads store resolvable from dir' };
  }

  const inWindow = runWindow(exitAt, entry.spawnedAt);
  const degraded: string[] = [];
  const store = taskStoreAt(beads);
  const { row, molParent, stepRows } = stepContext(store, beads, molStep, degraded);

  const ids = runIds(
    entry,
    molStep,
    molParent,
    stepRows.map(s => s.id)
  );
  const depTargets = depTargetsFor(molStep, molParent, stepRows);
  // the three evidence planes in contract order — first hit wins
  const probes: Array<() => LearnCheckResult | undefined> = [
    () => flaggedCloseHit(row, stepRows, molStep, inWindow),
    () => lessonHit({ home, beads, ids, inWindow, degraded }),
    () => retroHit(store, depTargets, inWindow, degraded),
  ];
  for (const probe of probes) {
    const hit = probe();
    if (hit !== undefined) {
      return hit;
    }
  }
  return degradedVerdict(degraded);
}
