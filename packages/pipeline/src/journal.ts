/**
 * The pipeline write-ahead journal — `<git-common>/bro/pipeline/
 * <run_id>.journal.jsonl`, one append-only JSONL file per run
 * (spec specs/bro-7d5nb.md §write-ahead journal). A stage's side
 * effects are never the resume point: the runner writes INTENT before
 * invoking an engine, then appends the same record again with `verdict`
 * filled once the stage settles — same `seq`, last row per seq wins on
 * read. An intent whose seq never completed means "the side effect may
 * or may not have landed"; resume re-checks the world instead of
 * re-firing blindly.
 *
 * Alert rows (`alert` set, intent `"alert"`) mark fail-closed parks — a
 * gate that could not evaluate, a fix verdict without notes, an
 * exhausted budget — and carry `resume`, the stage a wake re-enters.
 *
 * Storage mirrors the judge verdicts journal and the agents registry:
 * the common git dir is the shared plane (linked worktrees share it,
 * nothing lands in git); plain append is atomic at this size; reads
 * drop malformed lines so a torn tail can't poison the journal.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir } from '@broject/core';

/** One journal line — the write-ahead record. Snake_case on purpose:
 *  a stored wire shape like the registry rows, not a TS API surface.
 *  A `seq` appears once while only intent landed (the crash window)
 *  and twice once the verdict completes the record. */
export interface JournalRow {
  /** run the record belongs to */
  run_id: string;
  /** the pipeline item — a bead id */
  item: string;
  /** per-run monotonic step — joins an intent to its completing verdict */
  seq: number;
  /** stage the intent/alert concerns */
  stage: string;
  /** side-effect tag — the engine's intent word ('spawn', 'judge',
   *  'gate', 'capture'), 'gate' for synthesized skip records, 'alert'
   *  for fail-closed park rows */
  intent: string;
  /** nth invocation of this stage entry — retry bumps it, a fresh
   *  transition re-entry restarts at 1 */
  attempt: number;
  /** engine's verdict — absent while the intent is in flight */
  verdict?: string;
  /** typed stage output — merges into the pipeline context on read */
  payload?: unknown;
  /** scoped-fix round this intent runs under (review.fix → work) */
  fix_round?: number;
  /** the fix scope carried into a scoped re-entry */
  notes?: string;
  /** fail-closed park tag — presence marks an alert row */
  alert?: string;
  /** alert detail — which field, budget, or engine refused */
  detail?: string;
  /** stage a wake re-enters after an alert park */
  resume?: string;
  /** content-hash of the formula this run interprets */
  formula_sha: string;
  ts: string;
}

/** The runner-facing journal — append + read. File-backed under the
 *  shared git common dir via {@link openPipelineJournal}, or in-memory
 *  for tests and embedders that accept no durable resume. */
export interface PipelineJournal {
  /** the run the backing store belongs to, when it names one */
  readonly runId?: string;
  append(row: JournalRow): void;
  rows(): JournalRow[];
}

/** Run ids name a file — bound them to a path-safe token (the default
 *  `mintRunId` hex always passes). */
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** `<git-common>/bro/pipeline/<run_id>.journal.jsonl` — null outside a
 *  repo. An unsafe run id throws: a journal that could escape its dir
 *  is invalid input, not absence. */
export function pipelineJournalPath(dir: string, runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`pipeline journal: unsafe run id ${JSON.stringify(runId)}`);
  }
  const common = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return common === null ? null : join(common, 'bro', 'pipeline', `${runId}.journal.jsonl`);
}

/** The durable journal for `runId` under `dir`'s git common dir —
 *  null outside a repo (callers without a git dir have no durable
 *  plane; {@link memoryJournal} is the opt-in non-durable form). */
export function openPipelineJournal(dir: string, runId: string): PipelineJournal | null {
  const file = pipelineJournalPath(dir, runId);
  return file === null ? null : fileJournal(file, runId);
}

/** The run id a journal file name carries — `<run>.journal.jsonl`. */
function runIdFromPath(file: string): string | undefined {
  return /([^/\\]+)\.journal\.jsonl$/.exec(file)?.[1];
}

/** A file-backed journal. The file is read once at construction —
 *  one runner owns a journal file, so reads-after-append come from the
 *  object's own mirror and can never double-count its own lines; a
 *  resume constructs a fresh journal and re-reads. */
export function fileJournal(file: string, runId = runIdFromPath(file)): PipelineJournal {
  const all = readJournalFile(file);
  return {
    runId,
    append(row: JournalRow): void {
      appendJournalRow(file, row);
      all.push(row);
    },
    rows(): JournalRow[] {
      return [...all];
    },
  };
}

/** A non-durable journal — tests, and embedders that explicitly accept
 *  losing the resume contract on process death. */
export function memoryJournal(runId?: string): PipelineJournal {
  const all: JournalRow[] = [];
  return {
    runId,
    append(row: JournalRow): void {
      all.push(row);
    },
    rows(): JournalRow[] {
      return [...all];
    },
  };
}

/** Plain append is atomic at row size; the journal dir is created on
 *  first write. */
export function appendJournalRow(file: string, row: JournalRow): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** Minimal shape a parsed line must carry to count as a row — a
 *  torn-but-valid tail like `{"run_id":"x"}` fails this and is dropped
 *  rather than misread downstream. */
function isJournalRow(v: unknown): v is JournalRow {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false;
  }
  const r = v as JournalRow;
  return (
    typeof r.run_id === 'string' &&
    r.run_id !== '' &&
    typeof r.item === 'string' &&
    Number.isInteger(r.seq) &&
    typeof r.stage === 'string' &&
    r.stage !== '' &&
    typeof r.intent === 'string' &&
    r.intent !== '' &&
    typeof r.ts === 'string'
  );
}

/** The whole journal file, malformed lines dropped — a torn last line
 *  from a killed writer must not poison the read. */
export function readJournalFile(file: string): JournalRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: JournalRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const row: unknown = JSON.parse(line);
      if (isJournalRow(row)) {
        rows.push(row);
      }
    } catch {
      // torn write — skip
    }
  }
  return rows;
}

/** Records reconstructed from rows — last row per `seq` wins (an
 *  intent's completing verdict rewrites its line), seq-ordered. The
 *  runner reads this view: a record with `verdict` settled the stage,
 *  one without is the crash window, `alert` rows are fail-closed parks. */
export function journalRecords(rows: JournalRow[]): JournalRow[] {
  const bySeq = new Map<number, JournalRow>();
  for (const r of rows) {
    bySeq.set(r.seq, r);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The resume contract — the LAST record when its intent never
 *  completed (no verdict, not an alert): its side effect may or may not
 *  have landed. Anything earlier that stayed verdict-less is crash
 *  history superseded by a later intent — only the tail is actionable. */
export function pendingRecord(records: JournalRow[]): JournalRow | undefined {
  const last = records.at(-1);
  return last !== undefined && last.alert === undefined && last.verdict === undefined
    ? last
    : undefined;
}
