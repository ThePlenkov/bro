import { type PrTarget, readLifecycle } from '@broject/core';
import type { PrStateCache } from './state-cache.ts';
import type { PrActState } from './types.ts';

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
  return readLifecycle(dir, { pr: target.pr }).some(event => {
    const eventAt = Date.parse(event.ts);
    const detail = event.detail;
    return (
      Number.isFinite(eventAt) &&
      eventAt > fetchedAt &&
      typeof detail?.sha === 'string' &&
      detail.sha === state.headSha
    );
  });
}
