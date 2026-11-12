/**
 * ClaimFacade — session leases on resource URIs (epic spec
 * specs/sessions/bro-izpyk.md, "Claims and conflicts"). Contract only in
 * F1a: bro-izpyk.3 owns the semantics (leases, heartbeat, arming/occupancy
 * migration, `role:orchestrator` exclusivity) and the first provider. The
 * `claims` table already exists in the sqlite ledger schema so that slice
 * lands on a prepared store.
 *
 * Resource URIs: `worktree:<path>`, `branch:<name>`, `task:<id>`,
 * `pr:<n>`, `path:<glob>`, `role:<name>@<project>`. `task:*` delegates to
 * the tasks facade (the bd claim stays the source of truth); everything
 * else lives in the ledger backend.
 */
import type { SessionKey } from './ledger.ts';

export type ResourceUri = string;

export interface ClaimResult {
  ok: boolean;
  /** The standing claim that blocked this one, when `ok` is false. */
  conflict?: ClaimRow | null;
}

export interface ClaimRow {
  resource: string;
  host: string;
  sid: string;
  project: string | null;
  exclusive: boolean;
  /** Epoch ms; null = no expiry. */
  leaseUntil: number | null;
  /** Epoch ms. */
  claimedAt: number;
}

export interface ClaimQuery {
  project?: string;
  session?: SessionKey;
  /** Prefix match on the resource URI. */
  resource?: string;
}

export interface ClaimFacade {
  claim(
    resource: ResourceUri,
    session: SessionKey,
    opts?: { ttlMs?: number; exclusive?: boolean }
  ): Promise<ClaimResult>;
  release(resource: ResourceUri, session: SessionKey): Promise<void>;
  list(q?: ClaimQuery): Promise<ClaimRow[]>;
}
