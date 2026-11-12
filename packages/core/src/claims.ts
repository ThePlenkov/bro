/**
 * ClaimFacade — session leases on resource URIs (epic spec
 * specs/sessions/bro-izpyk.md, "Claims and conflicts"; impl spec
 * specs/bro-izpyk.3.md). F3 lands the semantics and the first provider:
 * `claims-store.ts` keeps every non-`task:*` URI as a lease row in the
 * sqlite ledger (`claims` table), `task:*` delegates to the tasks facade
 * so the bd claim stays the source of truth.
 *
 * Resource URIs: `worktree:<path>`, `branch:<name>`, `task:<id>`,
 * `pr:<n>`, `path:<glob>`, `role:<name>@<project>`. `role:*` claims are
 * exclusive by default — `role:orchestrator@<project>` is the spec's
 * per-project supervisor lock.
 */
import type { SessionKey } from './ledger.ts';

export type ResourceUri = string;

/** Default lease length — long enough that an interactive session's
 *  hook events renew it long before expiry, short enough that a silently
 *  dead holder frees the resource within a day. `ttlMs: 0` claims never
 *  expire by time (holder liveness still applies). */
export const CLAIM_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** The exclusive per-project supervisor role — `bro mode orchestrate`
 *  acquires it; the hook rearm paths check it. `<project>` is the
 *  `sessionProject` id (remote hash, else git-common realpath digest). */
export const ORCHESTRATOR_ROLE_NAME = 'orchestrator';

export function orchestratorRoleUri(project: string): string {
  return `role:${ORCHESTRATOR_ROLE_NAME}@${project}`;
}

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
  /** Holder agent pid when the claimant could prove one — the
   *  pid-reuse-safe liveness anchor (`pidStart` disambiguates). */
  pid?: number | null;
  pidStart?: string | null;
  /** The lease length this claim renews to on each holder heartbeat —
   *  epoch-ms TTL, not an absolute stamp. */
  ttlMs?: number | null;
  /** Free-form detail the claimant recorded (armed bead/slug/branch) —
   *  the migration bridge from marker detail lines. */
  detail?: string | null;
}

export interface ClaimQuery {
  project?: string;
  session?: SessionKey;
  /** Prefix match on the resource URI. */
  resource?: string;
}

export interface ClaimOptions {
  /** Lease length in ms — default CLAIM_DEFAULT_TTL_MS; 0 = no expiry. */
  ttlMs?: number;
  /** Exclusive claims refuse every other live holder; shared claims
   *  coexist unless the standing claim is exclusive. `role:*` URIs
   *  default to exclusive. */
  exclusive?: boolean;
  /** Holder agent pid + start stamp — provable liveness for the
   *  TTL-expiry/pid-dead release rule. */
  pid?: number;
  pidStart?: string;
  /** Recorded detail (bead id, slug, branch) — surfaced on list. */
  detail?: string;
  /** Project id override — defaults to the session row's project, then
   *  the `@<project>` suffix of `role:` URIs. */
  project?: string;
  /** Fallback project dir for `task:*` delegation when the session row
   *  carries no cwd (CLI callers pass their cwd). */
  dir?: string;
}

export interface ClaimFacade {
  claim(resource: ResourceUri, session: SessionKey, opts?: ClaimOptions): Promise<ClaimResult>;
  release(resource: ResourceUri, session: SessionKey): Promise<void>;
  list(q?: ClaimQuery): Promise<ClaimRow[]>;
}
