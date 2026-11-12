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
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
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
   *  'gate', 'capture', 'spec', 'verify', 'emit'), 'gate' for
   *  synthesized skip records, 'alert' for fail-closed park rows */
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
  /** the completing verdict came from the `admit` seam, not the
   *  engine — its payload is refusal detail, not stage output, so it
   *  never merges into the pipeline context */
  admit?: true;
  /** fail-closed park tag — presence marks an alert row */
  alert?: string;
  /** alert detail — which field, budget, or engine refused */
  detail?: string;
  /** stage a wake re-enters after an alert park */
  resume?: string;
  /** the run's recorded customer identity — stamped at creation so a
   *  resume can't silently swap who may sign the accept gate (a
   *  different `opts.customer` than the journaled one fails closed) */
  customer?: string;
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

/** Where a run's journal lives — a repo dir + the run id naming the
 *  file inside it. */
export interface JournalLocator {
  dir: string;
  runId: string;
}

/** Run ids name a file — bound them to a path-safe token (the default
 *  `mintRunId` hex always passes). Exported for the waker's mark-file
 *  writer, which derives run ids from journal filenames but must not
 *  trust that forever. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** `<git-common>/bro/pipeline/` — the shared plane every pipeline
 *  file lives in (journals, customer channels): linked worktrees see
 *  the same dir, nothing lands in git. Null outside a repo. */
export function pipelineDir(loc: Pick<JournalLocator, 'dir'>): string | null {
  const common = gitCommonDir(loc.dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return common === null ? null : join(common, 'bro', 'pipeline');
}

/** `<git-common>/bro/pipeline/<run_id>.journal.jsonl` — null outside a
 *  repo. An unsafe run id throws: a journal that could escape its dir
 *  is invalid input, not absence. */
export function pipelineJournalPath(loc: JournalLocator): string | null {
  if (!RUN_ID_RE.test(loc.runId)) {
    throw new Error(`pipeline journal: unsafe run id ${JSON.stringify(loc.runId)}`);
  }
  const dir = pipelineDir(loc);
  return dir === null ? null : join(dir, `${loc.runId}.journal.jsonl`);
}

/** The durable journal for a run under `loc.dir`'s git common dir —
 *  null outside a repo (callers without a git dir have no durable
 *  plane; {@link memoryJournal} is the opt-in non-durable form). */
export function openPipelineJournal(loc: JournalLocator): PipelineJournal | null {
  const file = pipelineJournalPath(loc);
  return file === null ? null : fileJournal(file);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const JOURNAL_SUFFIX = '.journal.jsonl';

/** A file-backed journal — `runId` derives from the `<run>.journal.
 *  jsonl` name (string ops, no regex: the path is uncontrolled input).
 *  The file is read once at construction: one runner owns a journal
 *  file, so reads-after-append come from the object's own mirror and
 *  never double-count its own lines; a resume constructs a fresh
 *  journal and re-reads. */
export function fileJournal(file: string): PipelineJournal {
  const all = readJournalFile(file);
  const sep = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const base = file.slice(sep + 1);
  const stem = base.endsWith(JOURNAL_SUFFIX)
    ? base.slice(0, base.length - JOURNAL_SUFFIX.length)
    : undefined;
  return {
    runId: stem === '' ? undefined : stem, // '.journal.jsonl' alone has no run id
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
 *  first write. A file that ends mid-row gets a separator first: a
 *  killed writer leaves a torn tail, and a naive append would
 *  concatenate the next row onto it — losing BOTH (the merged line
 *  parses as garbage and drops). The torn bytes stay torn; the row
 *  lands on a fresh line. O(1): only the last byte is read. The
 *  generic form — every pipeline-plane JSONL file (journals, customer
 *  channels) shares the same torn-tail append contract. */
export function appendJsonlRow(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  let sep = '';
  try {
    const size = statSync(file).size;
    if (size > 0) {
      const fd = openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        sep = last[0] === 0x0a ? '' : '\n';
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    sep = ''; // absent/unreadable file — nothing to separate from
  }
  appendFileSync(file, `${sep}${JSON.stringify(row)}\n`);
}

export function appendJournalRow(file: string, row: JournalRow): void {
  appendJsonlRow(file, row);
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';

/** Attempts and seqs start at 1 — a negative would resume into
 *  attempt 0 and quietly extend the retry budget. */
const posInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) > 0;

/** Fields a parsed line must carry to count as a row — a torn-but-
 *  valid tail like `{"run_id":"x"}` fails this and is dropped rather
 *  than misread downstream. Strings must be non-empty, counters real
 *  positive integers (a missing `attempt` would NaN the runner's
 *  budgets; a negative would extend them). */
const REQUIRED_STRINGS = ['run_id', 'item', 'stage', 'intent', 'ts'] as const;
const REQUIRED_INTS = ['seq', 'attempt'] as const;

function isJournalRow(v: unknown): v is JournalRow {
  if (!isRecord(v)) {
    return false;
  }
  const ints = REQUIRED_INTS.every(k => posInt(v[k]));
  const strings = REQUIRED_STRINGS.every(k => nonEmpty(v[k]));
  // formula_sha must be PRESENT (a missing field would crash the
  // drift check's .slice) but may be the empty string (runs started
  // without a sha stamp '').
  return ints && strings && typeof v.formula_sha === 'string';
}

/** The whole journal file, malformed lines dropped — a torn last line
 *  from a killed writer must not poison the read. */
export function readJournalFile(file: string): JournalRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    // Only a missing file means "empty journal" — an unreadable file
    // that IS present must not masquerade as an empty run (resume
    // would restart and repeat side effects).
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
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
