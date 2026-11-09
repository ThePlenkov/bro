/**
 * The session cap at the two call sites the admission does not cover
 * (spec bro-bww9v).
 *
 * The admission (bro's own spawn) has always enforced
 * `agents.<kind>.maxSessions` — but a cap about the ACCOUNT is enforced
 * at every place the account is spent, and two of them were open:
 *
 *  - the GUARD PLANE: a tool call about to start a vendor session (an
 *    agent running the CLI in its own worktree). The pre-tool verdict
 *    vetoes the call when the kind is at its cap. A hook fails OPEN: a
 *    count that cannot be established lets the call through — a hook
 *    must never stall the client (REVIEW.md).
 *  - the ACP SURFACE: the conductor's session facade. Every request
 *    opens a session on the shared peer and a retained conversation
 *    keeps one alive — and the plane cannot see those (one acp peer
 *    carries them all under one pid), so the conductor counts its own.
 *
 * The policy itself lives in the core (`@broject/core`'s session-cap
 * module) and the vendor knowledge in the vendor's package; this file
 * is the wiring — which config, which call site, which failure mode.
 */
import { createHash } from 'node:crypto';
import {
  SESSION_SLOT_TTL_MS,
  releaseSessionStart,
  reserveSessionStart,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
  type Connector,
  type ConnectorCtx,
  type PreToolVerdict,
  type SessionCapView,
} from '@broject/core';
import { loadAgentEnv } from '../agent-connectors.ts';

/** The refusal for a command about to start sessions, or undefined when
 *  it fits. Throws when the count cannot be established — the CALLER
 *  decides: a quota fails closed, a hook fails open. */
export function sessionCapRefusalForCommand(command: string, dir: string): string | undefined {
  const env = loadAgentEnv(dir);
  return sessionCapRefusalFor(command, env.agents);
}

/** The guard plane's verdict for one about-to-run tool call.
 *
 *  Only a command that some plane claims as a session start is judged;
 *  every other tool call passes untouched. The slot is claimed when the
 *  call is ALLOWED, so a burst of parallel starts shares one budget
 *  instead of each seeing the same headroom. */
export function sessionCapVerdict(
  ctx: ConnectorCtx,
  input: { tool: string; input: Record<string, unknown> },
  /** The `agents.<kind>` bags — the cap's knobs. Defaults to the
   *  repo's config; injectable for tests. */
  agents?: Record<string, Record<string, unknown>>
): PreToolVerdict[] {
  const command = typeof input.input['command'] === 'string' ? input.input['command'] : '';
  if (command.trim() === '') {
    return [];
  }
  let bags: Record<string, Record<string, unknown>>;
  try {
    bags = agents ?? loadAgentEnv(ctx.dir).agents;
  } catch {
    // the config could not be read — a hook fails OPEN
    return [];
  }
  let views: SessionCapView[];
  try {
    views = sessionCapViews(command, bags);
  } catch {
    // the count could not be established — a hook fails OPEN
    return [];
  }
  // The claim's key carries the CALL (its tool-use id when the client
  // sends one, the command otherwise), so the two hook events of one
  // call claim ONE slot, and two separate calls with the same command
  // claim their own.
  const key = `guard-${keyPart(ctx.sessionId ?? 'nosession')}-${callKey(command, ctx)}`;
  return judgeViews(views, bags, key);
}

/** Judge the kinds a command would start — claim the slot, then hold
 *  the call to the cap. */
function judgeViews(
  views: SessionCapView[],
  bags: Record<string, Record<string, unknown>>,
  key: string
): PreToolVerdict[] {
  for (const view of views) {
    const verdict = judgeView(view, bags, key);
    if (verdict !== undefined) {
      return [verdict];
    }
  }
  return [];
}

/** One kind's verdict — the claim, then the cap. */
function judgeView(
  view: SessionCapView,
  bags: Record<string, Record<string, unknown>>,
  key: string
): PreToolVerdict | undefined {
  let claimed: { paths: string[]; fresh: boolean };
  try {
    claimed = reserveSessionStart({
      kind: view.kind,
      agents: bags,
      key,
      count: view.starts,
    });
  } catch {
    // the claim could not be written — the count IS established, so
    // the cap still judges this call (a claim that cannot be taken
    // must not open a session the budget does not know about)
    const refusal = sessionCapRefusal(view);
    return refusal === undefined ? undefined : { block: refusal };
  }
  // A claim that was already there means this call is a repeat (the
  // other hook event for the same call): its start is counted once.
  const refusal = sessionCapRefusal(claimed.fresh ? view : { ...view, starts: 0 });
  if (refusal === undefined) {
    return undefined;
  }
  if (claimed.fresh) {
    releaseSessionStart(claimed.paths);
  }
  return { block: refusal };
}

/** The claim's key for one call — the tool-use id when the client
 *  sends one (the two hook events of one call share it), the command
 *  otherwise. */
function callKey(command: string, ctx: ConnectorCtx): string {
  const id = ctx.toolUseId;
  if (id === undefined || id === '') {
    return commandKey(command);
  }
  return `id-${keyPart(id)}`;
}

/** A raw client string into a reservation-key segment — filename-safe
 *  (no traversal, bounded length) AND lossless: the digest keeps two
 *  raws that sanitize alike (`a/b` vs `a?b`) from sharing a claim. */
function keyPart(raw: string): string {
  const safe = raw
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 48);
  // sha256 — the repo's digest convention; CodeQL reads session_id in a
  // sha1 as weak-crypto-on-sensitive-data even though the key is not crypto
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${safe}-${digest}`;
}

/** A short digest of a command — the claim's key half. The same
 *  command claims the same slot; a different one claims its own. */
function commandKey(command: string): string {
  return createHash('sha1').update(command).digest('hex').slice(0, 12);
}

/** The refusal for a command, from the hook's point of view.
 *
 *  The devin client sends no pre-tool event: its veto point is the
 *  PERMISSION request (the plugin's PermissionRequest hook). The cap
 *  has to run there too, or the very population the incident came
 *  from — an agent starting vendor sessions in its own worktree — walks
 *  past the cap untouched.
 *
 *  Fails OPEN: a hook must never stall the client (REVIEW.md). */
export function sessionCapRefusalForHook(
  command: string,
  dir: string,
  sessionId?: string,
  /** The `agents.<kind>` bags — injectable for tests. */
  agents?: Record<string, Record<string, unknown>>,
  /** The client's id for this tool call — the two hook events of one
   *  call share it, so they claim one slot. */
  toolUseId?: string
): string | undefined {
  try {
    const ctx = { dir, sessionId, toolUseId } as ConnectorCtx;
    const verdicts = sessionCapVerdict(ctx, { tool: 'exec', input: { command } }, agents);
    return verdicts[0]?.block;
  } catch {
    return undefined;
  }
}

/** The conductor's own budget — the ACP surface's session facade.
 *
 *  The plane counts live devin PROCESSES; the conductor's retained
 *  conversations share one peer process, so the plane sees one where
 *  the conductor holds many. The conductor counts its own retained and
 *  in-flight opens; the shared peer is already in the plane's count, so
 *  subtract one when any are present to avoid double counting it. */
export function conductorSessionRefusal(
  view: SessionCapView | undefined,
  retained: number,
  /** Opens whose own claim has EXPIRED — nothing else. A pending open
   *  still inside its claim's TTL already sits inside `view.live` (the
   *  reservation count `capViewFor` adds); counting it again here
   *  double-counts the slot and refuses requests while capacity
   *  remains. Use `pendingOpensBeyondClaim` to compute this. */
  inFlight = 0,
  starts = 1
): string | undefined {
  if (view === undefined) {
    return undefined;
  }
  const total = retained + inFlight;
  const live = view.live + (total > 0 ? total - 1 : 0);
  return sessionCapRefusal({ ...view, live, starts });
}

/** The in-flight opens a cap check must still count.
 *
 *  A pending open claims its slot BEFORE the session lands — while that
 *  claim is fresh the reservation count inside `view.live` already
 *  covers it. The claim expires with `SESSION_SLOT_TTL_MS`, but the
 *  open can outlive it (a retained session's first turn runs longer
 *  than the claim): past the TTL the open is in neither the sessions
 *  map nor the reservation count, so the check counts it directly.
 *  The map's value is the open's claim time (claim and mark are one
 *  step apart — the skew is milliseconds against a two-minute TTL). */
export function pendingOpensBeyondClaim(
  pending: ReadonlyMap<string, number>,
  now = Date.now()
): number {
  let n = 0;
  for (const claimedAt of pending.values()) {
    if (now - claimedAt >= SESSION_SLOT_TTL_MS) {
      n++;
    }
  }
  return n;
}

/** The connector — the guard plane's veto for a session start. */
export const sessionCapConnector: Connector = {
  name: 'session-cap',
  hooks: () => ({
    preTool(ctx, input) {
      return sessionCapVerdict(ctx, input);
    },
  }),
};
