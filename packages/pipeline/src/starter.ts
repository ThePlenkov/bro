/**
 * The production run-starter (specs/bro-qjji2.10.md) — the driver that
 * was missing: pick queued items, resolve the recorded customer, bind
 * the production engine map, stamp `formulaSha`, and invoke FRESH
 * `runPipeline` runs. This is the admission side only — resume/wake is
 * bro-v0pvd.3's (`resumePipeline`, the journal scan, the wake lock);
 * the starter never scans for resumable runs and never calls
 * `resumePipeline`. It meets the waker at exactly one artifact: the
 * `<runId>.formula.toml` sidecar it writes at creation.
 *
 * Provider-agnostic by construction: the queue source (which beads are
 * "queued"), the customer identity, the engine map, and admission are
 * all INJECTED — the CLI binds `readyBeads`+label, `bdActor`/env, the
 * pipeline-engines factory, and the go-marker policy. What lives here
 * is the orchestration the runner can't do for itself: dedup against
 * live journaled runs, sequential safe starts, per-item failure
 * isolation, and the formula sidecar.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transitionFor, type PipelineFormula } from './formula.ts';
import { fileJournal, journalRecords, pipelineDir, type JournalRow } from './journal.ts';
import { type EngineMap, type RunOptions, type RunOutcome, runPipeline } from './runner.ts';

// --- live-run dedup ---------------------------------------------------------

/** The terminal-DONE transition targets — a run whose tail settles to
 *  one of these is finished and its item is free to start again.
 *  `park`/`retry`/stage targets are NOT here: they are resumable waits
 *  the waker owns, so the item still counts as live. */
const DONE_TARGETS: ReadonlySet<string> = new Set(['end', 'close', 'abandon']);

/** Is this run's tail still live — anything but a settled terminal-done
 *  transition. A verdict-less intent (pending/crash window), an `alert`
 *  row (fail-closed park), and every non-done transition (park, retry,
 *  stage re-entry, or a missing-transition alert the runner parks on)
 *  all mean the run is owned — by a live drive, a parked wait, or the
 *  waker. Only `end`/`close`/`abandon` release the item. */
function tailIsLive(formula: PipelineFormula, tail: JournalRow): boolean {
  if (tail.alert !== undefined || tail.verdict === undefined) {
    return true;
  }
  const target = transitionFor(formula, tail.stage, tail.verdict);
  return target === undefined || !DONE_TARGETS.has(target);
}

/** The items that already have a LIVE journaled run — the dedup set the
 *  starter declines to re-start. Scans every `*.journal.jsonl` under the
 *  pipeline dir, groups each file's rows by item (run_id ↔ item is 1:1
 *  by contract; the per-item grouping is the same defensive read the
 *  waker's scanPipelineRuns does), seq-collapses, and keeps the items
 *  whose tail is live. An unreadable/missing pipeline dir yields an
 *  empty set — no plane means nothing ever ran, so nothing is owned.
 *  Tails classify against the CANDIDATE formula: production runs share
 *  the one formula, and the conservative direction (ambiguous → live)
 *  only ever skips, never double-fires. */
export function liveRunItems(dir: string, formula: PipelineFormula): Set<string> {
  const live = new Set<string>();
  const d = pipelineDir({ dir });
  if (d === null) {
    return live;
  }
  let files: string[];
  try {
    files = readdirSync(d);
  } catch {
    return live;
  }
  for (const f of files) {
    if (!f.endsWith('.journal.jsonl')) {
      continue;
    }
    const journal = fileJournal(join(d, f));
    const byItem = new Map<string, JournalRow[]>();
    for (const r of journal.rows()) {
      if (r.run_id !== journal.runId) {
        continue;
      }
      const g = byItem.get(r.item);
      if (g === undefined) {
        byItem.set(r.item, [r]);
      } else {
        g.push(r);
      }
    }
    for (const [item, rows] of byItem) {
      const records = journalRecords(rows);
      const tail = records.at(-1);
      if (tail !== undefined && tailIsLive(formula, tail)) {
        live.add(item);
      }
    }
  }
  return live;
}

// --- the formula sidecar -----------------------------------------------------

/** Write `<git-common>/bro/pipeline/<runId>.formula.toml` — the raw
 *  formula bytes the waker's `formulaFor` prefers when resolving a
 *  parked run's formula. runId is runner-minted (path-safe by the
 *  journal's RUN_ID_RE contract). Returns false outside a git repo —
 *  unreachable in practice (runPipeline needs the same dir for its
 *  file journal) but kept non-throwing: the sidecar is best-effort. */
export function writeFormulaSidecar(dir: string, runId: string, bytes: string | Buffer): boolean {
  const d = pipelineDir({ dir });
  if (d === null) {
    return false;
  }
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${runId}.formula.toml`), bytes);
  return true;
}

// --- startRuns ---------------------------------------------------------------

/** The RunOptions fields the starter forwards verbatim — everything a
 *  caller may legitimately tune (admit, maxInFlight, ctx, attempt/fix
 *  budgets, admitIntents). The starter-owned keys are stripped so no
 *  caller can fork run identity: `engines`, `dir`, `formulaSha`,
 *  `customer`, `journal`, `runId`. */
export type StartRunOptions = Omit<
  RunOptions,
  'engines' | 'dir' | 'formulaSha' | 'customer' | 'journal' | 'runId'
>;

export interface StartRunDeps {
  /** repo dir — resolves the file journal + pipeline plane via git
   *  common dir (must be inside a git repo, same contract as
   *  runPipeline's own journal requirement) */
  dir: string;
  /** the loaded formula — `sha` is the formulaSha drift baseline every
   *  journal row carries (runPipeline rejects an empty one) */
  formula: { formula: PipelineFormula; sha: string };
  /** raw formula bytes for the `<runId>.formula.toml` sidecar — absent
   *  skips the write (the waker's --formula-dir sha-match still serves
   *  the run). Present-but-unwritable reports `sidecar: false`, never
   *  fails the run. */
  formulaBytes?: string | Buffer;
  /** the run's recorded customer — the accept-gate authority. Passed
   *  through verbatim; the CLI resolves it fail-closed before calling
   *  (an absent customer means no identity can sign accept). */
  customer?: string;
  /** the bound engine map — prod binds the pipeline-engines factory */
  engines: EngineMap;
  /** candidate item ids — the queue scan's output or explicit args,
   *  deduplicated preserving first-seen order */
  items: readonly string[];
  /** RunOptions passthrough — admit, maxInFlight, ctx, budgets, … */
  runOptions?: StartRunOptions;
  /** report what WOULD start — dedup + candidate resolution run, but
   *  `runPipeline` is never invoked and no sidecar is written */
  dryRun?: boolean;
  /** test seam — defaults to the real runPipeline */
  run?: typeof runPipeline;
  /** test seam — defaults to {@link writeFormulaSidecar} */
  writeSidecar?: (dir: string, runId: string, bytes: string | Buffer) => boolean;
}

/** What happened to one candidate item. `would-start` is the dry-run
 *  answer — the item passed dedup and would get a fresh run. */
export type StartAction = 'started' | 'already-running' | 'failed' | 'would-start';

export interface StartItemReport {
  item: string;
  action: StartAction;
  /** set on 'started' — the run's minted/journaled id */
  runId?: string;
  outcome?: RunOutcome;
  stage?: string;
  verdict?: string;
  alert?: string;
  detail?: string;
  /** whether the `<runId>.formula.toml` sidecar landed — 'started' only */
  sidecar?: boolean;
  /** the thrown message — 'failed' only */
  error?: string;
}

export interface StartReport {
  dir: string;
  customer?: string;
  formulaSha: string;
  /** true when deps.dryRun — no runPipeline was invoked */
  dryRun: boolean;
  /** candidates considered (after empty/dup filtering) */
  scanned: number;
  /** runs actually invoked — 0 under dryRun */
  started: number;
  items: StartItemReport[];
}

/** Deduplicate candidate ids preserving first-seen order, dropping
 *  empty/whitespace entries — a blank id is never a runnable item. */
function candidates(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item === '' || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Start fresh pipeline runs for queued items — sequentially, one
 *  `runPipeline` per candidate, deduped against live journaled runs.
 *  Each run drives to its first park/halt; the occupancy semaphore
 *  (`stage-saturated`) queues the rest for the waker — the starter
 *  creates the runs, it does not drain them. A per-item throw is
 *  isolated to that item's `failed` row; the queue continues. */
export async function startRuns(deps: StartRunDeps): Promise<StartReport> {
  const items = candidates(deps.items);
  const live = liveRunItems(deps.dir, deps.formula.formula);
  const run = deps.run ?? runPipeline;
  const writeSidecar = deps.writeSidecar ?? writeFormulaSidecar;
  const report: StartReport = {
    dir: deps.dir,
    formulaSha: deps.formula.sha,
    dryRun: deps.dryRun === true,
    scanned: items.length,
    started: 0,
    items: [],
    ...(deps.customer !== undefined ? { customer: deps.customer } : {}),
  };
  for (const item of items) {
    if (live.has(item)) {
      report.items.push({ item, action: 'already-running' });
      continue;
    }
    if (deps.dryRun === true) {
      report.items.push({ item, action: 'would-start' });
      continue;
    }
    const opts: RunOptions = {
      engines: deps.engines,
      dir: deps.dir,
      formulaSha: deps.formula.sha,
      ...(deps.customer !== undefined ? { customer: deps.customer } : {}),
      ...(deps.runOptions ?? {}),
    };
    try {
      const res = await run(deps.formula.formula, item, opts);
      let sidecar = false;
      if (deps.formulaBytes !== undefined) {
        try {
          sidecar = writeSidecar(deps.dir, res.runId, deps.formulaBytes);
        } catch {
          sidecar = false; // best-effort — the waker's --formula-dir fallback serves
        }
      }
      report.started += 1;
      report.items.push({
        item,
        action: 'started',
        runId: res.runId,
        outcome: res.outcome,
        stage: res.stage,
        ...(res.verdict !== undefined ? { verdict: res.verdict } : {}),
        ...(res.alert !== undefined ? { alert: res.alert } : {}),
        ...(res.detail !== undefined ? { detail: res.detail } : {}),
        ...(deps.formulaBytes !== undefined ? { sidecar } : {}),
      });
    } catch (e) {
      report.items.push({
        item,
        action: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return report;
}
