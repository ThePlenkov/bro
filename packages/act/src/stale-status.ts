import { type PrTarget, readLifecycle } from '@broject/core';
import type { PrStateCache } from './state-cache.ts';
import type { PrActState } from './types.ts';

function isLaterSameHead(
  event: ReturnType<typeof readLifecycle>[number],
  fetchedAt: number,
  headSha: string
): boolean {
  const eventAt = Date.parse(event.ts);
  const detail = event.detail;
  return (
    Number.isFinite(eventAt) &&
    eventAt > fetchedAt &&
    typeof detail?.sha === 'string' &&
    detail.sha === headSha
  );
}

/** Whether a cached status was fetched before a later push/review event for
 * the same head. Missing telemetry is intentionally fail-open. */
export function staleStatus(
  dir: string,
  target: PrTarget,
  state: PrActState,
  cache: PrStateCache | null
): boolean {
  const fetchedAt = cache?.fetchedAt?.(target);
  if (fetchedAt === null || fetchedAt === undefined) {
    return false;
  }
  return readLifecycle(dir, { pr: target.pr }).some(event =>
    isLaterSameHead(event, fetchedAt, state.headSha)
  );
}
