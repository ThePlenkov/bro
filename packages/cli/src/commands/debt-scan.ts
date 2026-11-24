/** `bro debt collect`'s review-threads pipeline — candidate selection,
 *  the per-PR scan (bulk probe or serial fetch), harvest-file commits,
 *  and the debt:* label + processed-cursor bookkeeping. Split out of
 *  debt.ts — the module was past the CodeScene file-size bar. The
 *  shared `ScanCtx` bundles rev/args/labeling so the pipeline stages
 *  stay under the function-arity bar. */
import type { MergedPrScan, PrLabelOp, ReviewFacade } from '@broject/core';
import {
  applyCollectLabel,
  collectPr,
  collectThreads,
  type CollectPrResult,
  DEBT_STATES,
  debtLabel,
  ensureDebtLabels,
  markProcessedAt,
  partitionByProcessed,
  prDebtState,
  readLedgerOverlays,
  readProcessedAt,
  resolveHarvestPrs,
  upsertLedgerOverlays,
  writeHarvestFile,
  type DebtPrState,
  type DebtRecord,
} from '@broject/debt';
import type { CollectArgs } from './debt-args.ts';

// Review bots can comment AFTER merge+label. A labeled PR whose updatedAt
// is newer than our scan timestamp goes back into the queue — except
// `debt:skipped`, which is a human opt-out and is never rescanned.
function selectTargets(
  matched: Awaited<ReturnType<typeof resolveHarvestPrs>>,
  args: CollectArgs
): { targets: typeof matched; staleCount: number; processedCount: number } {
  const { pending, processed } = partitionByProcessed(matched);
  const processedAt = readProcessedAt();
  const futureBound = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const stale = processed.filter(pr => {
    if (prDebtState(pr.labels) === 'skipped') {
      return false;
    }
    const at = processedAt.get(pr.number);
    // No timestamp = labeled before this feature existed (or manually) —
    // rescan once to backfill; the scan then writes the timestamp.
    // A far-future cursor would suppress rescans forever — treat as stale.
    // Tolerance: the cursor is server time, so compare against local now+5m
    // to survive clock skew without flagging every PR.
    return at === undefined || at > futureBound || (pr.updatedAt !== null && pr.updatedAt > at);
  });
  return {
    targets: args.reharvest
      ? matched.filter(pr => prDebtState(pr.labels) !== 'skipped')
      : [...pending, ...stale],
    staleCount: stale.length,
    processedCount: processed.length,
  };
}

/** A reharvested thread that was marked done/wontfix is unresolved again
 *  — the terminal overlay must not shadow the fresh open evidence. */
export function reopenTerminalRows(rows: DebtRecord[]): void {
  const overlays = readLedgerOverlays();
  const reopen = rows.filter(r => {
    const s = overlays.get(r.thread_id)?.status;
    return s === 'done' || s === 'wontfix';
  });
  if (reopen.length === 0) {
    return;
  }
  upsertLedgerOverlays(
    reopen.map(r => {
      const prev = overlays.get(r.thread_id);
      return {
        thread_id: r.thread_id,
        status: 'open' as const,
        fix_pr: null,
        fixed_at: null,
        notes: prev?.notes ? `${prev.notes} | reopened by reharvest` : 'reopened by reharvest',
      };
    })
  );
  console.error(`debt: reopened ${reopen.length} terminal row(s) — still unresolved`);
}

interface ScannedPr {
  pr: number;
  result: CollectPrResult;
  /** Labels for the debt-state decision — probe-fresh in the bulk path,
   *  re-fetched post-collect in the serial path (same window as before). */
  labels: string[];
  /** updatedAt at probe time — the cursor for PRs that get no label
   *  write (nothing bumped it since the probe). Null in the serial path:
   *  the cursor phase re-fetches like the old loop did. */
  updatedAt: string | null;
  /** The candidate's list-time updatedAt — last-resort cursor fallback. */
  listedAt: string | null;
  scannedAt: string;
}

/** Everything a pipeline stage needs beyond the PR itself — the review
 *  facade, the run's parsed args, whether debt:* writes are enabled, and
 *  the total target count for the [pos/total] progress line. */
interface ScanCtx {
  rev: ReviewFacade;
  args: CollectArgs;
  labelingEnabled: boolean;
  total: number;
}

interface CollectedScan {
  result: CollectPrResult;
  labels: string[];
  updatedAt: string | null;
}

/** The bulk-probe arm — meta + threads + labels + updatedAt all ride in
 *  the scan envelope; no per-PR fetch needed. */
function collectFromScan(
  args: CollectArgs,
  pr: number,
  scan: MergedPrScan,
  harvestedAt: string
): CollectedScan {
  return {
    result: collectThreads({
      meta: {
        title: scan.info.title,
        url: scan.info.url,
        mergedAt: scan.info.mergedAt ?? scan.info.closedAt ?? '',
        mergeSha: scan.info.mergeSha,
      },
      threads: scan.threads,
      pr,
      runId: args.runId,
      threadAuthor: args.threadAuthor,
      harvestedAt,
    }),
    labels: scan.labels,
    updatedAt: scan.updatedAt,
  };
}

/** The serial arm — a per-PR collect, then a label re-fetch: the
 *  candidate snapshot predates this PR's collection, and a human may
 *  have opted out while we scanned. Skipped under --dry-run — no write
 *  will consult them. */
async function collectFromPr(ctx: ScanCtx, pr: number): Promise<CollectedScan> {
  const result = await collectPr(ctx.rev, {
    repo: ctx.args.repo,
    pr,
    runId: ctx.args.runId,
    threadAuthor: ctx.args.threadAuthor,
  });
  const labels =
    ctx.labelingEnabled && !ctx.args.dryRun ? ctx.rev.labels({ repo: ctx.args.repo, pr }) : [];
  return { result, labels, updatedAt: null };
}

/** Dry-run emit — rows go to stdout, nothing writes. */
function printDryRows(rows: DebtRecord[]): void {
  for (const row of rows) {
    console.log(JSON.stringify(row));
  }
}

/** Records for one PR — classified from the bulk probe when present,
 *  else the serial per-PR fetch (meta + threads + labels). Writes the
 *  harvest file; returns null on probe failure (warned, not thrown). */
async function scanPr(
  ctx: ScanCtx,
  pr: { number: number; updatedAt: string | null },
  scan: MergedPrScan | undefined,
  pos: number
): Promise<ScannedPr | null> {
  // Captured before fetching threads: activity arriving mid-scan is then
  // newer than the recorded timestamp and gets picked up next run.
  const scannedAt = new Date().toISOString();
  let collected: CollectedScan;
  try {
    collected =
      scan !== undefined
        ? collectFromScan(ctx.args, pr.number, scan, scannedAt)
        : await collectFromPr(ctx, pr.number);
  } catch (err) {
    console.error(
      `warning: PR ${ctx.rev.prLink(ctx.args.repo, pr.number)} skipped — ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
  console.error(
    `debt: [${pos}/${ctx.total}] PR ${ctx.rev.prLink(ctx.args.repo, pr.number)} — ${collected.result.incoming.length} thread(s)`
  );
  const s: ScannedPr = {
    pr: pr.number,
    result: collected.result,
    labels: collected.labels,
    updatedAt: collected.updatedAt,
    listedAt: pr.updatedAt,
    scannedAt,
  };
  if (ctx.args.dryRun) {
    printDryRows(collected.result.incoming);
    return s;
  }
  if (collected.result.incoming.length > 0) {
    writeHarvestFile({
      pr: collected.result.pr,
      runId: ctx.args.runId,
      harvestedAt: collected.result.incoming[0]!.harvested_at,
      records: collected.result.incoming,
    });
    reopenTerminalRows(collected.result.incoming);
  }
  return s;
}

interface LabelWrite {
  s: ScannedPr;
  op: PrLabelOp;
}

/** One label op per non-skipped PR — the machine state from the scan
 *  outcome. `skipped` is never in the remove set: a late human opt-out
 *  survives the write either way. */
function buildLabelWrites(args: CollectArgs, scanned: ScannedPr[]): LabelWrite[] {
  const writes: LabelWrite[] = [];
  for (const s of scanned) {
    if (prDebtState(s.labels) === 'skipped') {
      continue;
    }
    const state: DebtPrState = s.result.incoming.length > 0 ? 'collected' : 'clean';
    writes.push({
      s,
      op: {
        t: { repo: args.repo, pr: s.pr },
        add: [debtLabel(state)],
        // A remove names only labels the probe observed — removing an
        // absent label fails the whole pr-edit call, losing the add.
        remove: DEBT_STATES.filter(x => x !== 'skipped' && x !== state)
          .map(debtLabel)
          .filter(l => s.labels.some(have => have.toLowerCase() === l)),
      },
    });
  }
  return writes;
}

/** The bulk write — post-write updatedAt per applied PR; null when the
 *  connector lacks the fast path or the batch failed outright. */
async function bulkLabelWrites(
  rev: ReviewFacade,
  writes: LabelWrite[]
): Promise<Map<number, string | null> | null> {
  if (typeof rev.labelPrs !== 'function' || writes.length === 0) {
    return null;
  }
  try {
    return await rev.labelPrs(writes.map(w => w.op));
  } catch (err) {
    console.error(
      `warning: bulk label write failed — falling back per-PR ` +
        `(${err instanceof Error ? err.message : err})`
    );
    return null;
  }
}

/** One write — applied in bulk already, else the serial pre-bulk path.
 *  `stamp` is the post-write updatedAt when observed; `ok: false` means
 *  the write failed (unlabeled → rescan next run, self-healing). */
function ensureLabelWritten(
  ctx: ScanCtx,
  w: LabelWrite,
  wrote: Map<number, string | null> | null
): { ok: boolean; stamp: string | null } {
  if (wrote?.has(w.s.pr)) {
    return { ok: true, stamp: wrote.get(w.s.pr) ?? null };
  }
  try {
    applyCollectLabel(ctx.rev, {
      repo: ctx.args.repo,
      pr: w.s.pr,
      state: w.s.result.incoming.length > 0 ? 'collected' : 'clean',
    });
  } catch (err) {
    console.error(
      `warning: label write on ${ctx.rev.prLink(ctx.args.repo, w.s.pr)} failed — ` +
        `${err instanceof Error ? err.message : err}`
    );
    return { ok: false, stamp: null };
  }
  return { ok: true, stamp: null };
}

/** The processed cursor for a labeled PR: post-write updatedAt (bulk
 *  result or a fresh fetch) — a pre-write stamp would flag the PR stale
 *  on every later run. */
function writeCursor(ctx: ScanCtx, w: LabelWrite): string {
  return ctx.rev.prUpdatedAt(w.op.t) ?? w.s.updatedAt ?? w.s.listedAt ?? w.s.scannedAt;
}

/** Serial/bulk-fallback label writes + the post-write cursor. A failed
 *  write leaves the PR unlabeled — the next run rescans, self-healing. */
function applyLabelWrites(
  ctx: ScanCtx,
  writes: LabelWrite[],
  wrote: Map<number, string | null> | null
): number {
  let labeled = 0;
  for (const w of writes) {
    const res = ensureLabelWritten(ctx, w, wrote);
    if (!res.ok) {
      continue;
    }
    labeled += 1;
    markProcessedAt([w.s.pr], res.stamp ?? writeCursor(ctx, w));
  }
  return labeled;
}

/** Skipped PRs: no write touched them — probe-time updatedAt IS current;
 *  serial-path PRs fetch fresh, exactly like the old loop. */
function stampSkippedPrs(ctx: ScanCtx, scanned: ScannedPr[]): void {
  for (const s of scanned) {
    if (prDebtState(s.labels) !== 'skipped') {
      continue;
    }
    const cursor =
      s.updatedAt ??
      ctx.rev.prUpdatedAt({ repo: ctx.args.repo, pr: s.pr }) ??
      s.listedAt ??
      s.scannedAt;
    markProcessedAt([s.pr], cursor);
  }
}

/** Label writes + processed cursors for the scanned PRs — batched through
 *  `labelPrs` when the connector offers it, serial per-PR otherwise.
 *  `debt:skipped` is never written over and still earns a cursor: nothing
 *  changed for it, so probe-time updatedAt is the honest marker. */
async function labelScannedPrs(ctx: ScanCtx, scanned: ScannedPr[]): Promise<number> {
  const writes = buildLabelWrites(ctx.args, scanned);
  const wrote = await bulkLabelWrites(ctx.rev, writes);
  const labeled = applyLabelWrites(ctx, writes, wrote);
  stampSkippedPrs(ctx, scanned);
  return labeled;
}

function reportProbeProgress(started: number, done: number, total: number): void {
  const left =
    done > 0 && done < total
      ? `, ~${Math.round((((Date.now() - started) / done) * (total - done)) / 1000)}s left`
      : '';
  console.error(`debt collect: probed ${done}/${total} merged PR(s)${left}`);
}

/** The bulk probe — one call carries meta + threads + labels + updatedAt
 *  for every target when the connector offers it. Returns null when
 *  unavailable/failed: the per-PR loop then probes serially. */
async function probeTargets(
  ctx: ScanCtx,
  targets: Array<{ number: number }>
): Promise<Map<number, MergedPrScan> | null> {
  if (typeof ctx.rev.scanMergedPrs !== 'function' || targets.length === 0) {
    return null;
  }
  const started = Date.now();
  try {
    return await ctx.rev.scanMergedPrs(
      targets.map(pr => ({ repo: ctx.args.repo, pr: pr.number })),
      {
        onProgress: (done, total) => reportProbeProgress(started, done, total),
      }
    );
  } catch (err) {
    console.error(
      `warning: bulk scan failed — falling back to serial probes ` +
        `(${err instanceof Error ? err.message : err})`
    );
    return null;
  }
}

/** Probe → commit → label. The bulk probe carries meta+threads+labels+
 *  updatedAt per PR when the connector offers it; serial per-PR fetches
 *  inside scanPr cover whatever the bulk pass missed. */
async function harvestTargets(
  ctx: ScanCtx,
  targets: Awaited<ReturnType<typeof resolveHarvestPrs>>
): Promise<{ rows: number; labeled: number; failed: number }> {
  const scans = await probeTargets(ctx, targets);

  const scanned: ScannedPr[] = [];
  let rows = 0;
  let failed = 0;
  for (const [i, pr] of targets.entries()) {
    // Serial commit phase by design: ledger writes and the per-PR
    // progress line keep a deterministic order.
    const s = await scanPr(ctx, pr, scans?.get(pr.number), i + 1); // NOSONAR — deliberate serial awaits
    if (s === null) {
      failed += 1;
      continue;
    }
    scanned.push(s);
    rows += s.result.incoming.length;
  }

  const labeled =
    ctx.labelingEnabled && !ctx.args.dryRun && scanned.length > 0
      ? await labelScannedPrs(ctx, scanned)
      : 0;
  return { rows, labeled, failed };
}

/** --list-only render — number, merge stamp, author, debt state. */
function listTargets(targets: Awaited<ReturnType<typeof resolveHarvestPrs>>): void {
  for (const pr of targets) {
    console.log(
      `${pr.number}\t${pr.mergedAt ?? pr.closedAt ?? ''}\t${pr.author}\t${prDebtState(pr.labels) ?? 'none'}`
    );
  }
}

/** Whether debt:* label writes run this collect. A thread-author-filtered
 *  run is a partial scan — a PR-level "processed" label would hide other
 *  authors' unresolved threads from future runs. */
function prepareLabeling(rev: ReviewFacade, args: CollectArgs): boolean {
  const enabled = !args.noLabel && args.threadAuthor === null;
  if (args.threadAuthor !== null && !args.noLabel) {
    console.error('debt collect: --thread-author is a partial scan — labels disabled');
  }
  if (!args.dryRun && enabled) {
    ensureDebtLabels(rev, args.repo);
  }
  return enabled;
}

/** Harvest outcome — a skipped PR is missing evidence, not noise:
 *  automation reading the ledger must know the sweep was incomplete. */
function reportHarvest(
  labelingEnabled: boolean,
  rows: number,
  labeled: number,
  failed: number
): void {
  const labeledMsg = labelingEnabled ? `labeled ${labeled} PR(s)` : 'labels disabled';
  console.error(`debt collect: wrote ${rows} row(s), ${labeledMsg}`);
  if (failed > 0) {
    console.error(`debt collect: ${failed} PR(s) failed — collection is incomplete`);
    process.exitCode = 1;
  }
}

export async function collectReviewThreads(rev: ReviewFacade, args: CollectArgs): Promise<void> {
  // Fetch at least as many candidates as --last requests, or it silently caps.
  const listLimit = Math.max(args.filters.lastN ?? 0, 100);
  const matched = resolveHarvestPrs(rev, {
    repo: args.repo,
    filters: args.filters,
    listLimit,
    includeClosed: args.includeClosed || args.filters.prIds.length > 0,
  });
  const { targets, staleCount, processedCount } = selectTargets(matched, args);

  console.error(
    `debt collect: ${matched.length} PR(s) matched (merged/closed), ` +
      `${processedCount - staleCount} already processed (debt:* label)` +
      (staleCount > 0 ? `, ${staleCount} stale (post-scan activity)` : '') +
      `, scanning ${targets.length}`
  );

  if (args.listOnly) {
    listTargets(targets);
    return;
  }
  if (targets.length === 0) {
    return;
  }

  const labelingEnabled = prepareLabeling(rev, args);
  const { rows, labeled, failed } = await harvestTargets(
    { rev, args, labelingEnabled, total: targets.length },
    targets
  );
  reportHarvest(labelingEnabled, rows, labeled, failed);
}
