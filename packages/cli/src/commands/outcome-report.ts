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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitCommonDir } from '@broject/core';
import {
  ensureReporterToken,
  expireTaskText,
  findDecisions,
  linkDecision,
  migrateStore,
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

function appendOutbox(path: string, row: OutboxRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
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
    // newest first — the latest decision for a re-run bead is the live one
    for (const d of found.sort((a, b) => b.createdAt - a.createdAt)) {
      ids.add(d.decisionId);
    }
  } catch {
    /* journal unreadable — the pin still stands */
  } finally {
    handle.close();
  }
  return [...ids];
}

/** One delivery attempt — the router acknowledges every non-throw
 *  apply (inserted/updated/pending/retained/duplicate all count: the
 *  report reached the store's audit log). */
async function deliverIntent(intent: OutcomeIntent): Promise<boolean> {
  const path = routerStorePath();
  const handle = openStore(path);
  if (!handle.ok) {
    return false;
  }
  try {
    migrateStore(handle.db);
    const token = ensureReporterToken(path);
    await recordOutcome(
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
        sourceRevision: intent.sourceRevision,
      },
      {
        // bro is the merge authority — the store credential verifies it
        ...(token === undefined ? {} : { credential: token }),
      }
    );
    return true;
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
 *  is the counter's memory, so a restart never reuses a revision. */
async function nextSourceRevision(sourceId: string): Promise<number> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return Date.now();
  }
  try {
    migrateStore(handle.db);
    const rows = handle.db.$client
      .prepare(
        'select coalesce(max(source_revision), 0) as m from outcome_reports where source_id = ?'
      )
      .all(sourceId) as Array<{ m: number }>;
    return Math.max(Date.now(), Number(rows[0]?.m ?? 0) + 1);
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
    appendOutbox(outbox, { type: 'intent', intent });
    if (await deliverIntent(intent)) {
      appendOutbox(outbox, { type: 'delivered', eventId: intent.eventId });
      delivered += 1;
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
      appendOutbox(outbox, { type: 'delivered', eventId: intent.eventId });
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
