/** Runs awaiting customer input — discovered by scanning the
 *  pipeline dir's journals (`<git-common>/bro/pipeline/*.journal.
 *  jsonl`, spec specs/bro-7d5nb.md §customer channels). The journal
 *  plane is the discovery surface: a run parked at a customer gate
 *  shows up here whether it suspended on an intent, parked on an
 *  alert, or settled into a wait-state verdict — and the customer
 *  channel write commands target the run this scan names.
 *
 *  Split out of customer.ts: the channel file is the customer's
 *  INPUT ledger; this file is the journal-plane scan that finds who
 *  is waiting for it — different substrates, different readers. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileJournal, journalRecords, type PipelineJournal, pipelineDir } from './journal.ts';

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

/** The await target a scan looks for — which stage's park for which
 *  item, plus the settled-verdict words that name a wait state
 *  (`['questions']` for intake; absent for accept where every settled
 *  verdict is terminal-for-the-gate). */
export interface AwaitTarget {
  item: string;
  stage: string;
  verdicts?: readonly string[];
}

/** One journal file's tail → WHY its run awaits the customer, or
 *  undefined when it doesn't: an empty journal or a tail parked at
 *  another stage, and a settled verdict counts only when `verdicts`
 *  names it a wait state. The tail record decides — a pending intent
 *  or a repairable alert always counts. */
function awaitingVia(
  journal: PipelineJournal,
  target: Required<AwaitTarget>
): AwaitingRun['via'] | undefined {
  const records = journalRecords(
    journal.rows().filter(r => r.run_id === journal.runId && r.item === target.item)
  );
  const last = records.at(-1);
  if (last === undefined || (last.resume ?? last.stage) !== target.stage) {
    return undefined;
  }
  if (last.alert !== undefined) {
    return 'alert';
  }
  if (last.verdict === undefined) {
    return 'pending';
  }
  return target.verdicts.includes(last.verdict) ? 'verdict' : undefined;
}

/** Runs whose journal tail sits at `target.stage` awaiting customer
 *  input for `target.item`. The tail record decides: a pending intent
 *  or an alert with `resume`/`stage` at the stage always counts; a
 *  settled record counts only when its verdict is in `verdicts` (the
 *  wait-state words — `['questions']` for intake, `[]` for accept
 *  where every settled verdict is terminal-for-the-gate). */
export function awaitingCustomerRuns(dir: string, target: AwaitTarget): AwaitingRun[] {
  const d = pipelineDir({ dir });
  if (d === null) {
    return [];
  }
  const resolved = { ...target, verdicts: target.verdicts ?? [] };
  const out: AwaitingRun[] = [];
  for (const f of journalFileNames(d)) {
    const journal = fileJournal(join(d, f));
    if (journal.runId === undefined) {
      continue;
    }
    const via = awaitingVia(journal, resolved);
    if (via !== undefined) {
      out.push({ runId: journal.runId, stage: target.stage, via });
    }
  }
  return out;
}
