/**
 * The merge step closes on a VERDICT, not on a claim (bro-4cxnd).
 *
 * A merge step's `--result` is the agent's sentence — "PR #958 merged
 * (squash d11788ce)". The convoy used to accept that sentence as the
 * step's close reason, whatever the host said: the step could close for
 * a PR that was never merged, and the ledger could not say who landed
 * it.
 *
 * This module is the pure part — where the PR comes from, what the host
 * says, what the close reason reads. The host read lives with the
 * caller (the CLI owns the connectors); nothing here touches the
 * network.
 */
import { prRefs } from '@broject/core';

/** The step kind a formula declares for the step that lands the PR. A
 *  bd custom type, registered by `bro convoy pour` next to `agent` and
 *  `human`. */
export const MERGE_STEP_TYPE = 'merge-step';

/** What the host says about a PR. */
export interface MergeProbe {
  /** OPEN | MERGED | CLOSED — the host's own spelling, uppercased. */
  state: string;
  /** Who landed it — the host's merge record. */
  mergedBy?: string;
  /** The merge commit's sha — what actually landed. */
  mergeSha?: string;
}

/** The PR a merge claim is about. */
export interface MergeTarget {
  pr: number;
  /** `owner/repo` — absent when the reference carried no link. */
  repo?: string;
}

/** A merge step's claim: what the agent said, and what came before. */
export interface MergeClaim {
  /** the agent's own sentence (the `--result` text). */
  result: string;
  /** an explicit PR — the `--pr` flag beats any text. */
  pr?: number;
  /** the upstream handoff — the direct deps' close reasons. */
  inputs?: { id: string; reason: string }[];
}

export type MergeVerdict = { ok: true; reason: string } | { ok: false; message: string };

/** The one PR a set of references names — and the ambiguity verdict when
 *  they name more than one. */
function pickTarget(
  refs: { pr: number; repo?: string }[],
  source: string
): { target?: MergeTarget; message?: string } {
  const distinct = new Map<number, string | undefined>();
  for (const r of refs) distinct.set(r.pr, r.repo);
  if (distinct.size === 0) return {};
  if (distinct.size > 1) {
    const named = [...distinct.keys()].map(n => `#${n}`).join(', ');
    return {
      message: `the ${source} names ${distinct.size} different PRs (${named}) — the verifier cannot pick one; name the merged PR`,
    };
  }
  const first = distinct.entries().next();
  if (first.done) return {};
  const [pr, repo] = first.value;
  return { target: repo === undefined ? { pr } : { pr, repo } };
}

/** The PR the claim is about.
 *
 *  The explicit `--pr` wins. Otherwise the result's own references, then
 *  the upstream handoff's. Two different PRs in one source is ambiguity
 *  — the verifier must not pick one for the agent. */
export function mergeClaimTarget(claim: MergeClaim): { target?: MergeTarget; message?: string } {
  if (claim.pr !== undefined) {
    if (!Number.isInteger(claim.pr) || claim.pr <= 0) {
      return { message: `invalid PR number "${claim.pr}"` };
    }
    return { target: { pr: claim.pr } };
  }
  const own = pickTarget(prRefs(claim.result), 'result');
  if (own.target) return own;
  if (own.message) return own;
  const upstream = pickTarget(
    (claim.inputs ?? []).flatMap(input => prRefs(input.reason)),
    'handoff'
  );
  if (upstream.target) return upstream;
  if (upstream.message) return upstream;
  return {
    message:
      'the merge step names no PR — the claim cannot be verified; name the merged PR (--pr N, or a PR reference in the result)',
  };
}

/** The close reason: the verdict leads, the agent's claim follows it as
 *  the claim it is. The downstream steps read this as their input — the
 *  close-out step needs the PR that landed, and it takes it from the
 *  verdict line, not from prose. */
export function mergeCloseReason(
  target: MergeTarget,
  probe: MergeProbe,
  claim: MergeClaim
): string {
  const parts: string[] = [];
  if (probe.mergeSha) parts.push(`merge ${probe.mergeSha.slice(0, 8)}`);
  if (probe.mergedBy) parts.push(`by ${probe.mergedBy}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const head = `verified: PR #${target.pr} MERGED${detail}`;
  return claim.result.trim() === '' ? head : `${head}\n\n${claim.result.trim()}`;
}

/** Verify a merge claim against the host.
 *
 *  `MERGED` is the only state that closes the step. Every other answer
 *  — an open PR, a closed-unmerged PR, a host that cannot say — refuses:
 *  unverifiable is never verified. */
export async function verifyMergeClose(
  claim: MergeClaim,
  probe: (target: MergeTarget) => Promise<MergeProbe>
): Promise<MergeVerdict> {
  const { target, message } = mergeClaimTarget(claim);
  if (!target) {
    return { ok: false, message: message ?? 'the merge claim names no PR' };
  }
  let state: MergeProbe;
  try {
    state = await probe(target);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `the host could not answer for PR #${target.pr}: ${why}` };
  }
  if (state.state !== 'MERGED') {
    return {
      ok: false,
      message: `PR #${target.pr} is ${state.state || 'UNKNOWN'} — the gate holds; the merge step closes only on a merged PR`,
    };
  }
  return { ok: true, reason: mergeCloseReason(target, state, claim) };
}

/** A formula step's title against a poured step's title.
 *
 *  bd copies the formula's title into the issue, with the formula's
 *  `{{var}}`s interpolated — so the formula's pattern is matched with
 *  each variable as a wildcard. */
export function titleMatches(pattern: string, title: string): boolean {
  const parts = pattern.split(/(\{\{[^}]*\}\})/);
  let re = '';
  for (const part of parts) {
    if (/^\{\{[^}]*\}\}$/.test(part)) {
      re += '.*';
    } else {
      re += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(title.trim());
}
