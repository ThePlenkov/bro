/**
 * The outcome reporter (spec bro-0ykhg.4) — bro reports each routed
 * task's terminal verdict back to the router by decision id.
 *
 * Two durability rules shape this module:
 *
 *  - INTENT BEFORE DELIVERY. Every report lands in the durable outbox
 *    (`<git-common>/bro/outcomes/outbox.jsonl`) before the router sees
 *    it, so a crash between the terminal transition and the router's
 *    acknowledgement loses nothing — startup, wait's already-merged
 *    path and the reapers reconcile and retry until acknowledged.
 *    Retrying is idempotent: the event id derives from the report's
 *    own content, so the same verdict redelivers as the same event.
 *  - NEVER MERGE AGAIN TO REPORT. Reporting reads state; it never
 *    re-drives the merge. A 'merged' intent only exists after the PR
 *    state was actually observed merged.
 *
 * Verification: bro is the merge authority — it holds the store's
 * reporter credential, so its reports land verified. The router never
 * imports act; the credential is the whole seam.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendPrivateFileSync, gitCommonDir, mkdirPrivateSync } from '@broject/core';
import {
  ensureReporterToken,
  expireTaskText,
  findDecisions,
  linkDecision,
  migrateStore,
  nextSourceRevision as storeSourceRevision,
  openStore,
  recordOutcome,
  routerStorePath,
} from '@broject/router-store';
import type { OutcomeResult } from '@broject/router-store';
import { taskStore } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';

/** The outbox — one JSON intent per line, plus `delivered` markers. */
interface OutcomeIntent {
  eventId: string;
  decisionId: string;
  result: OutcomeResult;
  rounds?: number;
  threads?: number;
  cost?: number;
  tokens?: number;
  wallMs?: number;
  reporter: string;
  sourceId: string;
  sourceRevision: number;
  pr?: number;
  beadId?: string;
  at: number;
}

interface OutboxRow {
  type?: 'intent' | 'delivered';
  eventId?: string;
  intent?: OutcomeIntent;
}

/** The outbox path — beside the agents registry, same privacy plane. */
export function outcomeOutboxPath(dir: string): string | undefined {
  const common = gitCommonDir(dir);
  return common === null ? undefined : join(common, 'bro', 'outcomes', 'outbox.jsonl');
}

/** True when the outbox's last byte isn't a newline — a crash mid-append
 *  leaves a torn tail line, and the next row must start on its own line
 *  or readOutbox parse-fails the merged line and loses BOTH intents. */
function outboxNeedsNewline(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size === 0) {
      return false;
    }
    const fd = openSync(path, 'r');
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a; // '\n'
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function appendOutbox(path: string, row: OutboxRow): void {
  // owner-only like the agents registry — the intents name decisions,
  // beads and verdicts (the same privacy plane the spec draws)
  mkdirPrivateSync(dirname(path));
  const prefix = outboxNeedsNewline(path) ? '\n' : '';
  appendPrivateFileSync(path, `${prefix}${JSON.stringify(row)}\n`);
}

function readOutbox(path: string): { intents: OutcomeIntent[]; delivered: Set<string> } {
  const intents: OutcomeIntent[] = [];
  const delivered = new Set<string>();
  if (!existsSync(path)) {
    return { intents, delivered };
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line) as OutboxRow;
      if (row.type === 'delivered' && row.eventId !== undefined) {
        delivered.add(row.eventId);
      } else if (row.intent !== undefined) {
        intents.push(row.intent);
      }
    } catch {
      /* a torn tail line — the next append rewrites past it */
    }
  }
  return { intents, delivered };
}

/** The event id — deterministic over the report's content, so a retry
 *  of the SAME verdict is the SAME event (the router's idempotency
 *  key) and a corrected verdict is a new one. */
function eventIdFor(intent: Omit<OutcomeIntent, 'eventId'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        d: intent.decisionId,
        r: intent.result,
        rounds: intent.rounds ?? null,
        threads: intent.threads ?? null,
        cost: intent.cost ?? null,
        tokens: intent.tokens ?? null,
        wallMs: intent.wallMs ?? null,
        pr: intent.pr ?? null,
        bead: intent.beadId ?? null,
      })
    )
    .digest('hex')
    .slice(0, 32);
}

/** The decision ids a bead/PR/run resolves to — the bead's own
 *  `router:decision` metadata pin first (the current decision), then
 *  the journal's run-link reconciliation (bead/run/PR columns). */
export async function decisionIdsForRun(opts: {
  dir: string;
  beadId?: string;
  pr?: number;
  workerId?: string;
}): Promise<string[]> {
  const ids = new Set<string>();
  if (opts.beadId !== undefined) {
    try {
      const row = taskStore(opts.dir).get(opts.beadId);
      const pinned = row?.metadata?.['router:decision'];
      if (typeof pinned === 'string' && pinned !== '') {
        ids.add(pinned);
      }
    } catch {
      /* the store is best-effort — the journal still answers */
    }
  }
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return [...ids];
  }
  try {
    migrateStore(handle.db);
    const found = await findDecisions(handle.db, {
      ...(opts.beadId === undefined ? {} : { beadId: opts.beadId }),
      ...(opts.pr === undefined ? {} : { pr: String(opts.pr) }),
      ...(opts.workerId === undefined ? {} : { worker: opts.workerId }),
    });
    // newest first — a re-run bead journals one decision per attempt
    // and only the LATEST is this verdict's; reporting it to an
    // earlier attempt's decision would overwrite that attempt's own
    // outcome with a verdict that is not its
    const live = found.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (live !== undefined) {
      ids.add(live.decisionId);
    }
  } catch {
    /* journal unreadable — the pin still stands */
  } finally {
    handle.close();
  }
  return [...ids];
}

/** One delivery attempt — every non-throw apply counts as delivered:
 *  inserted/updated/pending/retained/duplicate all mean the report
 *  reached the store's audit log and the store made its verdict.
 *  'stale-revision' is the exception — it means a concurrent reporter
 *  claimed the same revision first, so the outcome row kept the older
 *  verdict; the intent re-issues under a fresh revision (bounded — a
 *  revision that keeps losing stays pending for the next reconcile). */
async function deliverIntent(intent: OutcomeIntent): Promise<boolean> {
  const path = routerStorePath();
  const handle = openStore(path);
  if (!handle.ok) {
    return false;
  }
  try {
    migrateStore(handle.db);
    const token = ensureReporterToken(path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sourceRevision =
        attempt === 0 ? intent.sourceRevision : storeSourceRevision(handle.db, intent.sourceId);
      const applied = await recordOutcome(
        handle,
        {
          decisionId: intent.decisionId,
          result: intent.result,
          ...(intent.rounds === undefined ? {} : { rounds: intent.rounds }),
          ...(intent.threads === undefined ? {} : { threads: intent.threads }),
          ...(intent.cost === undefined ? {} : { cost: intent.cost }),
          ...(intent.tokens === undefined ? {} : { tokens: intent.tokens }),
          ...(intent.wallMs === undefined ? {} : { wallMs: intent.wallMs }),
          reporter: intent.reporter,
          eventId: intent.eventId,
          sourceId: intent.sourceId,
          sourceRevision,
        },
        {
          // bro is the merge authority — the store credential verifies it
          ...(token === undefined ? {} : { credential: token }),
        }
      );
      if (applied.applied !== 'stale-revision') {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

/** Repair the journal's run links — the worker/run ids a spawn learns
 *  AFTER the decision journaled (the crash-between-journal-and-pin
 *  case the spec's reconciliation covers). Best-effort, never throws. */
export async function linkRunToDecision(
  dir: string,
  decisionId: string,
  links: { beadId?: string; worker?: string; runId?: string; pr?: number }
): Promise<void> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return;
  }
  try {
    migrateStore(handle.db);
    await linkDecision(handle, decisionId, {
      ...(links.beadId === undefined ? {} : { beadId: links.beadId }),
      ...(links.worker === undefined ? {} : { worker: links.worker }),
      ...(links.runId === undefined ? {} : { runId: links.runId }),
      ...(links.pr === undefined ? {} : { pr: String(links.pr) }),
    });
  } catch {
    /* the link is a repair — its absence costs the join, not the run */
  } finally {
    handle.close();
  }
}

/** The authority's next monotonic revision — max(Date.now(), the
 *  source's highest recorded revision + 1). Date.now() alone collides
 *  inside one millisecond (a loop settling a batch would drop every
 *  report but the first as stale-revision); the store's own audit log
 *  is the counter's memory, so a restart never reuses a revision. The
 *  counter itself lives in router-store — deliverIntent retries under
 *  it on the handle it already holds. */
async function nextSourceRevision(sourceId: string): Promise<number> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return Date.now();
  }
  try {
    migrateStore(handle.db);
    return storeSourceRevision(handle.db, sourceId);
  } catch {
    return Date.now();
  } finally {
    handle.close();
  }
}

/** Persist the intent, then try delivery — the durable half always
 *  lands first. Returns the intents written (one per resolved
 *  decision) and how many the router acknowledged this pass. */
export async function reportRoutedOutcome(opts: {
  dir: string;
  result: OutcomeResult;
  rounds?: number;
  threads?: number;
  cost?: number;
  tokens?: number;
  wallMs?: number;
  beadId?: string;
  pr?: number;
  workerId?: string;
  reporter?: string;
  sourceId?: string;
}): Promise<{ intents: number; delivered: number; decisionIds: string[] }> {
  const outbox = outcomeOutboxPath(opts.dir);
  const decisionIds = await decisionIdsForRun(opts);
  if (outbox === undefined || decisionIds.length === 0) {
    return { intents: 0, delivered: 0, decisionIds };
  }
  const reporter = opts.reporter ?? 'bro:act';
  const sourceId = opts.sourceId ?? 'bro:act';
  const now = Date.now();
  // one revision per report batch — every intent in it answers a
  // DIFFERENT decision, so sharing the revision is correct; the next
  // batch always lands strictly above it (spec bro-0ykhg.4)
  const revision = await nextSourceRevision(sourceId);
  const base = {
    result: opts.result,
    ...(opts.rounds === undefined ? {} : { rounds: opts.rounds }),
    ...(opts.threads === undefined ? {} : { threads: opts.threads }),
    ...(opts.cost === undefined ? {} : { cost: opts.cost }),
    ...(opts.tokens === undefined ? {} : { tokens: opts.tokens }),
    ...(opts.wallMs === undefined ? {} : { wallMs: opts.wallMs }),
    reporter,
    sourceId,
    // the authority's monotonic revision — a number the store compares,
    // never a lexical timestamp; strictly above every prior revision
    // this source recorded (same-ms batches cannot collide)
    sourceRevision: revision,
    ...(opts.pr === undefined ? {} : { pr: opts.pr }),
    ...(opts.beadId === undefined ? {} : { beadId: opts.beadId }),
    at: now,
  };
  let delivered = 0;
  for (const decisionId of decisionIds) {
    const intent: OutcomeIntent = {
      ...base,
      decisionId,
      eventId: eventIdFor({ ...base, decisionId }),
    };
    // intent-before-delivery — but a broken outbox must not lose the
    // verdict: delivery is idempotent by event id, so it proceeds
    // without the durable copy (loudly) rather than drop the report.
    // Only an undelivered intent WITH no durable copy is truly lost.
    let durable = true;
    try {
      appendOutbox(outbox, { type: 'intent', intent });
    } catch (err) {
      durable = false;
      console.error(
        `warning: outcome outbox ${outbox} refused the intent — ` +
          `${err instanceof Error ? err.message : String(err)}; delivering without the durable copy`
      );
    }
    if (await deliverIntent(intent)) {
      delivered += 1;
      if (durable) {
        try {
          appendOutbox(outbox, { type: 'delivered', eventId: intent.eventId });
        } catch {
          /* marker lost — reconcile redelivers as a duplicate-event no-op */
        }
      }
    }
  }
  return { intents: decisionIds.length, delivered, decisionIds };
}

/** Reconcile the outbox — retry every intent the router has not
 *  acknowledged. Startup, wait's already-merged path and the reapers
 *  call this; it also runs the retention sweep so expired text leaves
 *  on the same pass. Returns how many intents remain undelivered. */
export async function reconcileOutcomes(
  dir: string
): Promise<{ pending: number; delivered: number }> {
  const outbox = outcomeOutboxPath(dir);
  if (outbox === undefined) {
    return { pending: 0, delivered: 0 };
  }
  const { intents, delivered: done } = readOutbox(outbox);
  let delivered = 0;
  for (const intent of intents) {
    if (done.has(intent.eventId)) continue;
    if (await deliverIntent(intent)) {
      try {
        appendOutbox(outbox, { type: 'delivered', eventId: intent.eventId });
      } catch {
        /* marker lost — the next reconcile redelivers as a no-op */
      }
      delivered += 1;
    }
  }
  // the retention sweep rides the same pass — taskTextRetentionDays
  // from the operator's brouter config (default 30; 0 already kept
  // text out at write time)
  try {
    const days = loadBroConfig(dir).brouter?.taskTextRetentionDays ?? 30;
    const handle = openStore(routerStorePath());
    if (handle.ok) {
      try {
        migrateStore(handle.db);
        await expireTaskText(handle, { retentionDays: days });
      } finally {
        handle.close();
      }
    }
  } catch {
    /* retention is housekeeping — never blocks reconciliation */
  }
  const stillPending = intents.filter(i => !done.has(i.eventId)).length - delivered;
  return { pending: Math.max(0, stillPending), delivered };
}
