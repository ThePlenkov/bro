/**
 * The customer channel — `<git-common>/bro/pipeline/<run_id>.
 * customer.jsonl`, one append-only JSONL file per run (spec
 * specs/bro-7d5nb.md §stage semantics — accept/answer). It carries
 * the customer's out-of-band input the suspended run wakes on:
 *
 *   {kind:"verdict", item, verdict, accepted_by, notes?, ts} — what
 *       `bro pipeline accept <item> …` writes; the accept gate reads
 *       it back through its `verdictStore` seam
 *   {kind:"answer",  item, answers, by?, ts} — what
 *       `bro pipeline answer <item> …` writes; intake's `questions`
 *       park wakes on the enriched spec
 *
 * Per-run, not per-item: a verdict physically cannot settle a run it
 * was not written for — a re-run of the same item gets a fresh empty
 * channel, and stale input from a dead run's file never leaks. Same
 * shared plane and append conventions as the journals: the common
 * git dir (linked worktrees share it, nothing lands in git), plain
 * append with torn-tail separation, malformed lines dropped on read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MaybePromise } from '@broject/core';
import {
  appendJsonlRow,
  fileJournal,
  type JournalLocator,
  journalRecords,
  type PipelineJournal,
  pipelineDir,
} from './journal.ts';
import type { StageCall } from './runner.ts';

/** The channel file's suffix — `<run_id>.customer.jsonl` sits beside
 *  `<run_id>.journal.jsonl`. */
export const CUSTOMER_SUFFIX = '.customer.jsonl';

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/** The customer's accept-gate verdict — the record `bro pipeline
 *  accept` appends. `accepted_by` is the signer's identity: the gate
 *  passes only when it equals the run's recorded `customer`. */
export interface CustomerVerdict {
  kind: 'verdict';
  /** the pipeline item — audit provenance (the file already keys the run) */
  item: string;
  /** one of the accept stage's declared verdicts — accepted|rejected|abandon */
  verdict: string;
  /** who signed — the run's recorded customer identity, never the worker */
  accepted_by: string;
  /** the customer's fix scope — required non-empty on `rejected` */
  notes?: string;
  ts: string;
}

/** The customer's answers to intake's `questions` — the record
 *  `bro pipeline answer` appends. `answers` is free-form (a qid→answer
 *  map, a text message): the stage that consumes it owns the shape. */
export interface CustomerAnswer {
  kind: 'answer';
  item: string;
  answers: unknown;
  /** who answered — optional; intake does not gate on it */
  by?: string;
  ts: string;
}

/** A drain marker — the intake pass consumed the channel rows it
 *  saw: the `answer` records it covered are already annotated on the
 *  item and must never re-feed a later wake.
 *
 *  `upto` is the marker's BOUND — the channel row count the draining
 *  pass read. A bare position marker could not say that: a row
 *  appended between the feed's read and the marker lands BEFORE the
 *  marker and position-bound reads would count it consumed — input
 *  the customer gave, silently lost (the run re-parks at questions
 *  waiting for it forever). Markers written before `upto` existed
 *  bind by their own position instead — the only rows they can
 *  honestly vouch for are the ones that preceded them. */
export interface CustomerConsumed {
  kind: 'consumed';
  item: string;
  /** channel rows covered — index bound: rows `>= upto` stay pending */
  upto?: number;
  ts: string;
}

export type CustomerRecord = CustomerVerdict | CustomerAnswer | CustomerConsumed;

/** `<git-common>/bro/pipeline/<run_id>.customer.jsonl` — null outside
 *  a repo. Same path-safety rule as the journal: an unsafe run id
 *  throws, it never escapes the dir. */
export function customerChannelPath(loc: JournalLocator): string | null {
  if (!RUN_ID_RE.test(loc.runId)) {
    throw new Error(`customer channel: unsafe run id ${JSON.stringify(loc.runId)}`);
  }
  const dir = pipelineDir(loc);
  return dir === null ? null : join(dir, `${loc.runId}${CUSTOMER_SUFFIX}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Append one record to a run's channel — the torn-tail append the
 *  journals use. */
export function appendCustomerRecord(file: string, rec: CustomerRecord): void {
  appendJsonlRow(file, rec);
}

/** The whole channel file — parsed record lines only; a torn last
 *  line or a non-record value drops like the journal's malformed
 *  rows. A PRESENT but unreadable file throws (ENOENT alone means
 *  "no customer input yet") — silent emptiness would strand the gate. */
export function readCustomerFile(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row)) {
        rows.push(row);
      }
    } catch {
      // torn write — skip
    }
  }
  return rows;
}

/** A row the gate treats as verdict input: an explicit `kind:"verdict"`
 *  record, or a kind-less record still carrying a `verdict` field (a
 *  hand-written row the gate should see — and still fully validate).
 *  An unrecognized `kind` is NOT a candidate: the writer of record is
 *  the CLI, and a row claiming another kind must not be misread as a
 *  verdict. */
const isVerdictCandidate = (v: unknown): boolean =>
  isRecord(v) && (v.kind === 'verdict' || (v.kind === undefined && 'verdict' in v));

/** The latest verdict candidate — LAST row wins (a corrected record
 *  supersedes an earlier malformed one). Returned raw: shape and
 *  identity validation belong to the gate, which fails closed on a
 *  malformed record rather than silently skipping it. */
export function latestVerdict(rows: unknown[]): unknown | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isVerdictCandidate(rows[i])) {
      return rows[i];
    }
  }
  return undefined;
}

/** The durable `verdictStore` binding — reads THIS run's customer
 *  channel for the latest verdict record; undefined means the
 *  customer has not answered (no repo, no channel, or no verdict row
 *  yet — all read identically as "still waiting"). */
export function fileVerdictStore(dir: string) {
  return (call: StageCall): unknown | undefined => {
    const file = customerChannelPath({ dir, runId: call.runId });
    if (file === null) {
      return undefined;
    }
    return latestVerdict(readCustomerFile(file));
  };
}

/** A well-formed `upto` — the channel row count a marker records:
 *  a non-negative integer, nothing else. */
const isUpto = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** One consumed marker's index bound — `upto` when the marker
 *  records the row count it saw, else its own position +1 (a
 *  pre-`upto` marker vouches only for the rows before it). A
 *  malformed `upto` reads as a legacy marker — never a wider bound
 *  than the marker can prove. */
const markerBound = (r: Record<string, unknown>, i: number): number =>
  isUpto(r.upto) ? r.upto : i + 1;

/** Rows not yet covered by a `consumed` marker — the pending answer
 *  input a waking intake drains. A marker bounds by the row count it
 *  saw (`upto`): a record appended between the feed's read and the
 *  marker lands inside the marker's position but OUTSIDE its bound,
 *  so it stays pending instead of being silently eaten. A marker
 *  without `upto` (pre-bound writes) vouches only for rows before
 *  its own position. Verdict rows ride the same file: they are not
 *  intake input, but the next marker covers them too — the accept
 *  store reads the whole file regardless. */
export function pendingAnswers(rows: unknown[]): unknown[] {
  let start = 0;
  rows.forEach((r, i) => {
    if (isRecord(r) && r.kind === 'consumed') {
      start = Math.max(start, markerBound(r, i));
    }
  });
  return rows.slice(start);
}

/** What the intake wake drains — the pending channel rows plus the
 *  marker append. `consume` must run only AFTER the records' payload
 *  is durable on the item: a crash between annotate and marker
 *  re-feeds the rows on the next wake (the annotate is append-shaped,
 *  so a re-drain adds a fresh `## Answers` section, never a clobber);
 *  the other order could lose the answers entirely. */
export interface AnswerFeed {
  /** every channel row since the last consumed marker — raw; the
   *  consuming stage validates each record's shape and fails closed */
  records: unknown[];
  /** append the drain marker — rows before it are never re-fed */
  consume(): MaybePromise<void>;
}

/** The durable answer-feed binding — the run's own channel file,
 *  `fileVerdictStore`'s intake-side sibling. The marker records the
 *  row count this read saw (`upto`), not just a position: a record
 *  appended between the read and the marker lands at index `>= upto`
 *  and stays pending — a bound marker can never eat a record it did
 *  not see. */
export function fileAnswerFeed(dir: string) {
  return (call: StageCall): AnswerFeed => {
    const file = customerChannelPath({ dir, runId: call.runId });
    if (file === null) {
      return { records: [], consume: () => {} };
    }
    const rows = readCustomerFile(file);
    return {
      records: pendingAnswers(rows),
      consume: () =>
        appendCustomerRecord(file, {
          kind: 'consumed',
          item: call.item,
          upto: rows.length,
          ts: new Date().toISOString(),
        }),
    };
  };
}

/** One run parked where a customer acts — discovered by scanning the
 *  pipeline dir's journals. `via` is WHY it counts as awaiting:
 *  'pending' a verdict-less intent at the stage (accept's suspended
 *  emit), 'alert' a fail-closed park a corrected record can repair
 *  (verdict-malformed, customer-mismatch, fix-notes-missing), and
 *  'verdict' a settled record whose verdict names a wait state
 *  (intake's `questions` park). */
export interface AwaitingRun {
  runId: string;
  stage: string;
  via: 'pending' | 'alert' | 'verdict';
}

/** The pipeline dir's `*.journal.jsonl` file names — [] when the
 *  dir itself can't be listed: no pipeline dir means nothing ever
 *  ran here, and a discovery scan that can't read the plane finds
 *  nothing rather than dying on it. */
function journalFileNames(d: string): string[] {
  try {
    return readdirSync(d).filter(f => f.endsWith('.journal.jsonl'));
  } catch {
    return []; // no pipeline dir — nothing ever ran here
  }
}

/** One journal file's tail → WHY its run awaits the customer, or
 *  undefined when it doesn't: an empty journal or a tail parked at
 *  another stage, and a settled verdict counts only when `verdicts`
 *  names it a wait state. The tail record decides — a pending intent
 *  or a repairable alert always counts. */
function awaitingVia(
  journal: PipelineJournal,
  item: string,
  stage: string,
  verdicts: readonly string[]
): AwaitingRun['via'] | undefined {
  const records = journalRecords(
    journal.rows().filter(r => r.run_id === journal.runId && r.item === item)
  );
  const last = records.at(-1);
  if (last === undefined || (last.resume ?? last.stage) !== stage) {
    return undefined;
  }
  if (last.alert !== undefined) {
    return 'alert';
  }
  if (last.verdict === undefined) {
    return 'pending';
  }
  return verdicts.includes(last.verdict) ? 'verdict' : undefined;
}

/** Runs whose journal tail sits at `stage` awaiting customer input
 *  for `item`. The tail record decides: a pending intent or an alert
 *  with `resume`/`stage` at the stage always counts; a settled record
 *  counts only when its verdict is in `verdicts` (the wait-state
 *  words — `['questions']` for intake, `[]` for accept where every
 *  settled verdict is terminal-for-the-gate). */
export function awaitingCustomerRuns(
  dir: string,
  item: string,
  stage: string,
  verdicts: readonly string[] = []
): AwaitingRun[] {
  const d = pipelineDir({ dir });
  if (d === null) {
    return [];
  }
  const out: AwaitingRun[] = [];
  for (const f of journalFileNames(d)) {
    const journal = fileJournal(join(d, f));
    if (journal.runId === undefined) {
      continue;
    }
    const via = awaitingVia(journal, item, stage, verdicts);
    if (via !== undefined) {
      out.push({ runId: journal.runId, stage, via });
    }
  }
  return out;
}

/** One channel append behind the seams both CLI subs share —
 *  resolves the run's channel file and appends `rec`. */
export function writeCustomerRecord(loc: JournalLocator, rec: CustomerRecord): void {
  const file = customerChannelPath(loc);
  if (file === null) {
    throw new Error(`no pipeline plane under ${loc.dir} — not a git repo`);
  }
  appendCustomerRecord(file, rec);
}
