/**
 * `bro act` presentation layer — the human-readable status block, the
 * landed/settled phrasing the wait and merge verdicts share, and the
 * veto-review display helpers. Imports stay at core + @broject/act so
 * any act module can render without closing a cycle.
 */
import { listWatches, type ExitGate, type GateWaitResult, type PrActState } from '@broject/act';
import type { PrTarget, ReviewFacade, VetoReview } from '@broject/core';

export function printStatus(state: PrActState, gate: ExitGate, stale = false): void {
  // clickable by convention (AGENTS.md): user-facing PR refs are links —
  // state.url is the PR's own html_url, so this is also GHE-safe
  console.log(`pr=[#${state.pr}](${state.url}) ${state.headRef}`);
  console.log(
    `mergeable=${state.mergeable} merge_state=${state.mergeState} draft=${state.isDraft}`
  );
  console.log(
    `open_threads=${gate.open_threads} ci_pending=${gate.ci_pending} ` +
      `ci_failing=${gate.ci_failing} ` +
      `reviewers_pending=${gate.reviewers_pending} ` +
      `reviewers_failing=${gate.reviewers_failing} ` +
      `sast_pending=${gate.sast_pending} sast_unknown=${gate.sast_unknown} ` +
      `fix_rounds=${gate.fix_rounds} docs_only=${gate.docs_only} ` +
      `reopened_threads=${gate.reopened_threads}` +
      // the host veto axis — a CHANGES_REQUESTED blocks merges with
      // zero open threads; surface it only when it says something
      (state.reviewDecision === undefined || state.reviewDecision === 'APPROVED'
        ? ''
        : ` review_decision=${state.reviewDecision}`)
  );
  console.log(`exit_gate=${gate.ok ? 'OK' : 'BLOCKED'}`);
  if (stale) {
    console.log('status=STALE');
  }
  // the veto axis detail — which standing CHANGES_REQUESTED reviews are
  // stale (dismissible) vs live; absent when the probe didn't run or
  // the host can't enumerate (the blocker text covers that case)
  for (const v of state.vetoReviews ?? []) {
    console.log(
      v.stale
        ? // stale implies ≥1 referenced thread — zero refs reads live
          `  veto: ${v.author} review ${v.id} — stale ` +
            `(${v.threads} thread(s) resolved+outdated) ` +
            `— \`bro act dismiss ${state.pr}\` clears it`
        : `  veto: ${v.author} review ${v.id} — live (${
            v.threads === 0
              ? 'no referenced threads — body-only veto'
              : `${v.threads} referenced thread(s) not all settled`
          }) — wait for re-review`
    );
    // the review body can carry an objection no thread anchors — show
    // ALL of it, untruncated, so a "stale" label is never read without
    // the whole ask (VetoReview.body contract — codeant/coderabbit on
    // PR #1020)
    const body = vetoBodyText(v);
    if (body !== '') {
      console.log(`    body: "${body}"`);
    }
  }
  const live = listWatches(process.cwd()).filter(l => l.alive && l.watch.pr === state.pr);
  console.log(
    `watch=${live.length > 0 ? `live pid=${live[0]!.watch.pid}` : `none — \`bro act wait ${state.pr}\` arms one`}`
  );
  for (const b of gate.blockers) {
    console.log(`  blocker: ${b}`);
  }
  for (const a of gate.alerts) {
    console.log(`  alert: ${a}`);
  }
}

/** The settled wait's journal `to` — timeout, blocked, externally
 *  settled (merged/closed mid-poll), or green. */
export function waitVerdict(res: GateWaitResult): string {
  if (res.timedOut) {
    return 'timeout';
  }
  // A landed PR satisfies a merge wait even when its last gate snapshot
  // still contains blockers. The lifecycle state is the verdict; the gate
  // only describes whether bro could have landed it itself.
  if (res.state.state === 'MERGED') {
    return 'merged';
  }
  if (!res.gate.ok) {
    return 'blocked';
  }
  return res.state.state === 'OPEN' ? 'green' : res.state.state.toLowerCase();
}

/** The landed phrase — "was already merged", with the actor when the
 *  host names it (the host's merge record). undefined for a PR that is
 *  not merged (spec: specs/bro-0i1lm.md). */
export function landedPhrase(state: PrActState): string | undefined {
  if (state.state !== 'MERGED') return undefined;
  return state.mergedBy === undefined
    ? 'was already merged'
    : `was already merged by ${state.mergedBy}`;
}

/** The verdict line a caller reads — the PR link and the landing.
 *  The fallback names the state instead of claiming a merge: a
 *  non-merged state must never read as "was already merged". */
export function landedLine(rev: ReviewFacade, t: PrTarget, state: PrActState): string {
  return `act: ${rev.prLink(t.repo, t.pr)} ${landedPhrase(state) ?? `is ${state.state}`}`;
}

/** The settled label for the verdict event — 'MERGED', 'MERGED by
 *  <actor>', or 'CLOSED'. */
export function settledLabel(state: PrActState): string {
  if (state.state === 'MERGED' && state.mergedBy !== undefined) {
    return `MERGED by ${state.mergedBy}`;
  }
  return state.state.toUpperCase();
}

/** The veto's body as a single display line — whitespace-collapsed and
 *  NEVER truncated: `VetoReview.body` exists because a body-level
 *  objection has no thread anchor, so every dismissal-decision surface
 *  must show the whole text — any cutoff could hide the ask that
 *  matters past it (codeant/coderabbit on PR #1020). */
export const vetoBodyText = (v: VetoReview): string => v.body?.replace(/\s+/g, ' ').trim() ?? '';

/** One-line body note for veto display — the full text per vetoBodyText. */
export const vetoBodyNote = (v: VetoReview): string => {
  const b = vetoBodyText(v);
  return b === '' ? '' : ` — body: "${b}"`;
};
