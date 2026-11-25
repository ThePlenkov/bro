/**
 * `bro act dismiss` — clear STALE standing veto reviews. Extracted from
 * act.ts verbatim; the dry-run report, the pre-mutation re-read, and the
 * per-candidate probe→dismiss became named helpers so the command reads
 * as guard → probe → targets → dismiss.
 */

import type { ReviewFacade, VetoReview } from '@broject/core';
import { emitLifecycle, ensureAuth, reviewHost } from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { type ResolvedTarget, resolvePr } from './act-args.ts';
import { dropActState } from './act-land.ts';
import { vetoBodyNote } from './act-report.ts';
import { flag } from './args.ts';

/** The dismissal note the host records — `--message` overrides; the
 *  default names the rule that made the veto dismissible so the PR's
 *  review history reads honestly afterwards. */
const DEFAULT_DISMISS_MESSAGE = 'stale review — all referenced threads resolved (bro act dismiss)';

/** One veto as a dismiss-report line — stale ⇒ ≥1 referenced thread,
 *  so the count is always real here. */
const describeVeto = (v: VetoReview): string =>
  `${v.author}'s review ${v.id} — ${v.threads} thread(s) resolved+outdated`;

/** The --dry-run report — what would be dismissed (or why nothing). */
function reportDismissDryRun(vetoes: VetoReview[], stale: VetoReview[]): void {
  if (stale.length === 0) {
    console.log(
      vetoes.length === 0
        ? 'act dismiss: no standing veto reviews'
        : `act dismiss: ${vetoes.length} veto(s) stand, none stale — nothing to dismiss`
    );
    return;
  }
  for (const v of stale) {
    console.log(`would dismiss ${describeVeto(v)}${vetoBodyNote(v)}`);
  }
}

/** The pre-mutation re-read: a thread reopened (or a fresh objection
 *  posted) between the first probe and the dismissal loop must not be
 *  cleared off a stale snapshot — the window can't fully close without
 *  a host lock, but this narrows it to the mutation call itself
 *  (coderabbit on PR #1020). The fresh veto objects are the ones
 *  dismissed — author/threads may have moved too. */
async function freshStaleTargets(
  rev: ReviewFacade,
  t: ResolvedTarget,
  stale: VetoReview[]
): Promise<VetoReview[]> {
  const fresh = await rev.vetoReviews!(t);
  const stillStale = new Map(fresh.filter(v => v.stale).map(v => [v.id, v]));
  const toDismiss = stale
    .map(v => stillStale.get(v.id))
    .filter((v): v is VetoReview => v !== undefined);
  for (const v of stale) {
    if (!stillStale.has(v.id)) {
      console.log(`act: ${describeVeto(v)} no longer stale on re-read — skipped`);
    }
  }
  return toDismiss;
}

/** One candidate's probe→dismiss — re-probe before EACH mutation, not
 *  only once before the loop: a thread reopened by an earlier dismissal
 *  in this same batch must not be cleared off the batch snapshot — the
 *  residual window narrows to this entry's own probe→mutation gap (no
 *  host lock closes it fully; codeant/coderabbit on PR #1020). The
 *  fresh veto object is the one dismissed — author/threads may have
 *  moved. False = the dismissal itself failed; a skipped candidate
 *  (no longer stale on re-read) is a pass, not a failure. */
async function dismissCandidate(
  rev: ReviewFacade,
  t: ResolvedTarget,
  candidate: VetoReview,
  message: string
): Promise<boolean> {
  const probed = await rev.vetoReviews!(t);
  const v = probed.find(c => c.id === candidate.id && c.stale);
  if (v === undefined) {
    console.log(`act: ${describeVeto(candidate)} no longer stale on re-read — skipped`);
    return true;
  }
  // the body surfaces BEFORE the mutation — a body-level objection is
  // invisible to the thread rule, so the operator/agent deciding the
  // dismissal reads the whole review here
  console.log(`dismissing ${describeVeto(v)}${vetoBodyNote(v)}`);
  try {
    rev.dismissReview?.(t, v.id, message);
    console.log(`act: dismissed ${describeVeto(v)}`);
    emitLifecycle(process.cwd(), {
      kind: 'verdict',
      pr: t.pr,
      to: 'dismissed',
      detail: { via: 'act', review: v.id, author: v.author },
    });
    return true;
  } catch (err) {
    console.error(
      `act: dismissing ${describeVeto(v)} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/**
 * `bro act dismiss` — clear STALE standing veto reviews
 * (reviewDecision=CHANGES_REQUESTED whose referenced threads are all
 * resolved+outdated — bro-n1foa). The stale filter is the safety: a
 * live veto is refused by construction, never by a flag the caller
 * must remember — re-review is the reviewer's call, dismissal is only
 * ever offered on settled evidence. Strict PR resolution: a mutation
 * never guesses which PR's reviews to clear.
 */
export async function cmdDismiss(argv: string[]): Promise<void> {
  const cfg = loadBroConfig();
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: cfg.connectors });
  const rev = reviewHost(undefined, cfg.connectors);
  const t = resolvePr(rev, argv, 'strict');
  if (rev.vetoReviews === undefined || rev.dismissReview === undefined) {
    console.error(
      `error: ${rev.prLink(t.repo, t.pr)} — this review host cannot enumerate or dismiss reviews`
    );
    process.exitCode = 1;
    return;
  }
  // a mutation validates its target's lifecycle — dismissing reviews on
  // a merged/closed PR clears nothing that still gates and only looks
  // like it did something
  const meta = rev.prMetaAsync !== undefined ? await rev.prMetaAsync(t) : rev.prMeta(t);
  if (meta.state !== 'OPEN') {
    console.error(
      `error: ${rev.prLink(t.repo, t.pr)} is ${meta.state} — only OPEN PRs carry a live veto`
    );
    process.exitCode = 1;
    return;
  }
  // fresh probe, never the shared feed — the enumeration IS the
  // decision input, same rule as the merge gate (bro-0tcrl)
  const vetoes = await rev.vetoReviews(t);
  const stale = vetoes.filter(v => v.stale);
  if (argv.includes('--dry-run')) {
    reportDismissDryRun(vetoes, stale);
    return;
  }
  if (stale.length === 0) {
    console.log(
      vetoes.length === 0
        ? 'act dismiss: no standing veto reviews'
        : `act dismiss: ${vetoes.length} veto(s) stand but none are stale — wait for re-review`
    );
    return;
  }
  const toDismiss = await freshStaleTargets(rev, t, stale);
  if (toDismiss.length === 0) {
    console.log('act dismiss: no veto still stale — nothing dismissed');
    return;
  }
  const message = flag(argv, '--message') ?? DEFAULT_DISMISS_MESSAGE;
  let failed = 0;
  for (const candidate of toDismiss) {
    if (!(await dismissCandidate(rev, t, candidate, message))) {
      failed += 1;
    }
  }
  // a dismissal moves reviewDecision — the shared feed's next read
  // must fetch, not serve the pre-dismissal veto for up to a TTL
  dropActState(t);
  if (failed > 0) {
    console.error(`act dismiss: ${failed} of ${toDismiss.length} dismissal(s) failed`);
    process.exitCode = 1;
  }
}
