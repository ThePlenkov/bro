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
import { ghHost, prLink, prRefs } from '@broject/core';
import type { PrRef } from '@broject/core';

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
  /** the host the link named — absent for the bare form. */
  host?: string;
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

/** Where a claim's PR may be named — the result's own words, then the
 *  upstream handoff. */
interface RefSource {
  name: string;
  refs: PrRef[];
}

/** The PRs a set of references names — one entry per PR number, with
 *  the repository and host that name it, plus the numbers two
 *  repositories disagree on. */
interface Collected {
  byNumber: Map<number, MergeTarget>;
  conflicts: number[];
}

/** The explicit PR — `--pr N`. An unusable number is refused, not
 *  guessed. */
function explicitTarget(pr: number | undefined): { target?: MergeTarget; message?: string } | undefined {
  if (pr === undefined) return undefined;
  if (!Number.isInteger(pr) || pr <= 0) {
    return { message: `invalid PR number "${pr}"` };
  }
  return { target: { pr } };
}

/** Where the PR may be named — the result's own text, then the
 *  upstream handoff's close reasons. */
function claimSources(claim: MergeClaim): RefSource[] {
  return [
    { name: 'result', refs: prRefs(claim.result) },
    { name: 'handoff', refs: (claim.inputs ?? []).flatMap((input) => prRefs(input.reason)) },
  ];
}

/** A target that carries only what is known — no empty repository, no
 *  empty host. */
function targetOf(pr: number, repo: string | undefined, host: string | undefined): MergeTarget {
  const target: MergeTarget = { pr };
  if (repo !== undefined) target.repo = repo;
  if (host !== undefined) target.host = host;
  return target;
}

/** Fold a second reference into the first — the link's repository and
 *  host survive a bare reference, and two repositories (or two hosts)
 *  for one PR number are a conflict the verifier cannot settle. */
function mergeRefs(known: MergeTarget, ref: PrRef): { target: MergeTarget; conflict: boolean } {
  const repo = known.repo ?? ref.repo;
  const host = known.host ?? ref.host;
  const conflict =
    (known.repo !== undefined && ref.repo !== undefined && known.repo !== ref.repo) ||
    (known.host !== undefined && ref.host !== undefined && known.host !== ref.host);
  return { target: targetOf(known.pr, repo, host), conflict };
}

/** The PRs a set of references names. */
function collectTargets(refs: PrRef[]): Collected {
  const byNumber = new Map<number, MergeTarget>();
  const conflicts = new Set<number>();
  for (const ref of refs) {
    const known = byNumber.get(ref.pr);
    if (known === undefined) {
      byNumber.set(ref.pr, targetOf(ref.pr, ref.repo, ref.host));
      continue;
    }
    const merged = mergeRefs(known, ref);
    byNumber.set(ref.pr, merged.target);
    if (merged.conflict) conflicts.add(ref.pr);
  }
  return { byNumber, conflicts: [...conflicts] };
}

/** The PR numbers, as they read in a message. */
function numbered(prs: number[]): string {
  return prs.map((n) => `#${n}`).join(', ');
}

/** The one PR a set of references names — and the ambiguity verdict
 *  when they name more than one. */
function pickTarget(refs: PrRef[], source: string): { target?: MergeTarget; message?: string } {
  const collected = collectTargets(refs);
  if (collected.conflicts.length > 0) {
    return {
      message: `the ${source} names ${numbered(collected.conflicts)} in two repositories — the verifier cannot pick one; name the merged PR`,
    };
  }
  if (collected.byNumber.size > 1) {
    return {
      message: `the ${source} names ${collected.byNumber.size} different PRs (${numbered([...collected.byNumber.keys()])}) — the verifier cannot pick one; name the merged PR`,
    };
  }
  const target = [...collected.byNumber.values()][0];
  if (target === undefined) return {};
  return { target };
}

/** The PR the claim is about.
 *
 *  The explicit `--pr` wins. Otherwise the result's own references, then
 *  the upstream handoff's. Two different PRs in one source is ambiguity
 *  — the verifier must not pick one for the agent. */
export function mergeClaimTarget(claim: MergeClaim): { target?: MergeTarget; message?: string } {
  const explicit = explicitTarget(claim.pr);
  if (explicit !== undefined) return explicit;
  for (const source of claimSources(claim)) {
    const picked = pickTarget(source.refs, source.name);
    if (picked.target !== undefined) return picked;
    if (picked.message !== undefined) return picked;
  }
  return {
    message:
      'the merge step names no PR — the claim cannot be verified; name the merged PR (--pr N, or a PR reference in the result)',
  };
}

/** How the PR reads in the verdict — the clickable link when the claim
 *  named the repository, the bare number when it did not. */
function prRefText(target: MergeTarget): string {
  if (target.repo === undefined) return `PR #${target.pr}`;
  return prLink(target.repo, target.pr);
}

/** The merge record — the sha that landed, and who landed it. */
function mergeDetail(probe: MergeProbe): string {
  const parts: string[] = [];
  if (probe.mergeSha !== undefined) parts.push(`merge ${probe.mergeSha.slice(0, 8)}`);
  if (probe.mergedBy !== undefined) parts.push(`by ${probe.mergedBy}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
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
  const head = `verified: ${prRefText(target)} MERGED${mergeDetail(probe)}`;
  const said = claim.result.trim();
  return said === '' ? head : `${head}\n\n${said}`;
}

/** The host the connector reads — a claim that names another host names
 *  another PR, and this host cannot vouch for it. */
function hostMismatch(target: MergeTarget): string | undefined {
  if (target.host === undefined) return undefined;
  if (target.host === ghHost()) return undefined;
  return `the claim names PR #${target.pr} on ${target.host}, but this connector reads ${ghHost()}`;
}

/** The host's answer — the probe's own words when it failed. */
async function askHost(
  target: MergeTarget,
  probe: (t: MergeTarget) => Promise<MergeProbe>
): Promise<{ state: MergeProbe } | { error: string }> {
  try {
    return { state: await probe(target) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** The verdict for a target the claim names — the host's answer decides
 *  it: only `MERGED` closes the step. */
async function verdictFor(
  target: MergeTarget,
  claim: MergeClaim,
  probe: (t: MergeTarget) => Promise<MergeProbe>
): Promise<MergeVerdict> {
  const answered = await askHost(target, probe);
  if ('error' in answered) {
    return { ok: false, message: `the host could not answer for PR #${target.pr}: ${answered.error}` };
  }
  if (answered.state.state !== 'MERGED') {
    return {
      ok: false,
      message: `PR #${target.pr} is ${answered.state.state || 'UNKNOWN'} — the gate holds; the merge step closes only on a merged PR`,
    };
  }
  return { ok: true, reason: mergeCloseReason(target, answered.state, claim) };
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
  if (target === undefined) {
    return { ok: false, message: message ?? 'the merge claim names no PR' };
  }
  const mismatch = hostMismatch(target);
  if (mismatch !== undefined) return { ok: false, message: mismatch };
  return verdictFor(target, claim, probe);
}
