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
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  admitSessionStart,
  planesStartingSessions,
  SESSION_SLOT_TTL_MS,
  releaseSessionStart,
  reserveSessionStart,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
  sessionReservationsDir,
  SpawnError,
  type Connector,
  type ConnectorCtx,
  type PreToolVerdict,
  type SessionCapView,
  type SessionStartAdmission,
} from '@broject/core';
import { loadAgentEnv } from '../agent-connectors.ts';

/** How long the guard waits on the admission mutex before degrading to
 *  the un-locked path — a hook must never stall the client. The locked
 *  section is a dir scan plus a file write, so a live holder yields in
 *  milliseconds; 2s only bites on a wedged one. */
export const GUARD_LOCK_WAIT_MS = 2_000

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
  agents?: Record<string, Record<string, unknown>>,
  /** The admission mutex's wait bound — injectable for tests. */
  lockWaitMs = GUARD_LOCK_WAIT_MS
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
  // The claim's key carries the CALL when the client sends a tool-use
  // id (the two hook events of one call share it); without one there
  // is no per-call identity at all — see `callKey`.
  const key = `guard-${keyPart(ctx.sessionId ?? 'nosession')}-${callKey(command, ctx)}`;
  // a pre-update event of THIS call may still hold its slot under the
  // raw (pre-sanitization) key — move it under the new key BEFORE the
  // locked count, or the admission reads the same call as a stranger
  // and refuses it at cap (the upgrade window's double-count)
  const legacy = legacyKey(command, ctx);
  if (legacy !== undefined) {
    for (const plane of planesStartingSessions(command)) {
      migrateLegacyClaims(plane.kind, bags, legacy, key);
    }
  }
  // the locked check+claim first — the cap serializes on the kind's
  // OWN admission mutex, so a burst of parallel starts shares one
  // budget exactly instead of each seeing the same headroom. EVERY
  // capped plane claiming the command is judged: a refusal on a later
  // plane still vetoes the call, and the claims earlier planes took
  // are released — a refused start runs nothing, so no call may hold
  // their slots.
  const admissions: SessionStartAdmission[] = [];
  let lockedRefusal: string | undefined;
  try {
    for (const plane of planesStartingSessions(command)) {
      const admission = admitSessionStart({
        plane,
        command,
        agents: bags,
        key,
        waitMs: lockWaitMs,
      });
      if (admission === undefined) {
        continue;
      }
      if (admission.refusal !== undefined) {
        lockedRefusal = admission.refusal;
        break;
      }
      admissions.push(admission);
    }
  } catch (err) {
    releaseClaims(admissions);
    if (err instanceof SpawnError) {
      // the count could not be established (or a malformed cap) — a
      // hook fails OPEN
      return [];
    }
    // the mutex outlived the hook's wait, or a claim could not be
    // written — never stall the client: the un-locked path still
    // applies the budget, and its claim-then-count order keeps a
    // racing burst honest (the slot write is atomic, so the recount
    // sees every claim that landed before it)
    return verdictUnlocked(command, bags, key, legacyKey(command, ctx));
  }
  if (lockedRefusal !== undefined) {
    releaseClaims(admissions);
    return [{ block: lockedRefusal }];
  }
  return [];
}

/** Drop the claims a verdict already took — the slots THIS call wrote
 *  (a repeat event's held slots belong to the earlier event and are
 *  never in `admission.paths`, so a plain release is safe). */
function releaseClaims(admissions: SessionStartAdmission[]): void {
  for (const held of admissions) {
    releaseSessionStart(held.paths);
  }
}

/** The un-locked check+claim — the hook's contention fallback.
 *
 *  Without the mutex the check and the claim cannot be one section, so
 *  the order inverts: claim FIRST (each `wx` slot write is atomic),
 *  then re-count. A racing start's claim either landed before the
 *  recount — it is inside `live` and this call refuses itself — or
 *  lands after — that call sees THIS claim and refuses itself. The
 *  stale pre-claim headroom the old order judged is never read, so a
 *  fallback burst cannot slip past the cap together. */
function verdictUnlocked(
  command: string,
  bags: Record<string, Record<string, unknown>>,
  key: string,
  legacyKey?: string
): PreToolVerdict[] {
  let views: SessionCapView[];
  try {
    views = sessionCapViews(command, bags);
  } catch {
    // the count could not be established — a hook fails OPEN
    return [];
  }
  // claim every kind's slots before counting — the recount then holds
  // this call's claims AND every claim a racer landed first
  const claims: { kind: string; paths: string[] }[] = [];
  try {
    for (const view of views) {
      const claimed = reserveSessionStart({
        kind: view.kind,
        agents: bags,
        key,
        count: view.starts,
      });
      claims.push({ kind: view.kind, paths: claimed.paths });
      if (claimed.fresh && legacyKey !== undefined) {
        // A pre-update event of this call may already hold a slot under
        // the old key: the claim is this call's, so the fresh files
        // must not add a SECOND count on top of it. The new files stay
        // (the next event dedups on them); the legacy files retire.
        releaseSessionStart(legacyClaims(view, bags, legacyKey));
      }
    }
  } catch {
    // a claim could not be written — keep none of them; the recount
    // still judges the call (a claim that cannot be taken must not
    // open a session the budget does not know about)
    for (const c of claims) {
      releaseSessionStart(c.paths);
    }
    claims.length = 0;
  }
  let counted: SessionCapView[];
  try {
    counted = sessionCapViews(command, bags);
  } catch {
    for (const c of claims) {
      releaseSessionStart(c.paths);
    }
    return [];
  }
  for (const view of counted) {
    // this call's claims are already inside `live` — subtract them and
    // pass them back as `starts`, so `live - own + own` judges whether
    // live alone broke the cap (a fresh claim on a full kind still
    // refuses); the kind whose claim failed is judged on its own
    // starts (the slot it could not take)
    const claimed = claims.find(c => c.kind === view.kind);
    const refusal = sessionCapRefusal(
      claimed !== undefined
        ? { ...view, live: view.live - claimed.paths.length, starts: claimed.paths.length }
        : view
    );
    if (refusal !== undefined) {
      for (const c of claims) {
        releaseSessionStart(c.paths);
      }
      return [{ block: refusal }];
    }
  }
  return [];
}

/** The claim's key for one call — the tool-use id when the client
 *  sends one (the two hook events of one call share it). When the
 *  client sends none there is NO per-call identity: keying on the
 *  command reads a second, DISTINCT call as a repeat of the first and
 *  lets it past the cap uncounted — so the fallback is unique per
 *  event. A client that fires two cap-checked events per call without
 *  an id double-claims for the claim's TTL — the count errs toward
 *  the budget, never past it. */
function callKey(command: string, ctx: ConnectorCtx): string {
  const id = ctx.toolUseId;
  if (id === undefined || id === '') {
    return `evt-${process.pid}-${randomBytes(6).toString('hex')}`;
  }
  return `id-${keyPart(id)}`;
}

/** The PRE-SANITATION claim key this call would have used — raw
 *  session id and raw tool-use id, as written before `keyPart`
 *  existed. Only an existing file is ever touched, and only inside
 *  the kind's reservations dir; a raw segment that cannot be a plain
 *  file name (`/` or `..` — the very thing `keyPart` now sanitizes)
 *  can never have been claimed, so there is nothing to recognize. */
function legacyKey(command: string, ctx: ConnectorCtx): string | undefined {
  const session = ctx.sessionId ?? 'nosession';
  const id = ctx.toolUseId;
  const call = id === undefined || id === '' ? commandKey(command) : `id-${id}`;
  const legacy = `guard-${session}-${call}`;
  return /[/\\]|\.\./.test(legacy) ? undefined : legacy;
}

/** Move this call's raw-key claims under the sanitized key — a rename
 *  keeps the claim while making the locked count recognize it as OURS.
 *  A target that already exists means the new key holds a slot too —
 *  the dup retires; either way no two files ever count one call. Runs
 *  outside the mutex: the window only ever double-counts the call
 *  against ITSELF (over-count, never past the budget). */
function migrateLegacyClaims(
  kind: string,
  bags: Record<string, Record<string, unknown>>,
  legacyKey: string,
  key: string
): void {
  const dir = sessionReservationsDir(kind, bags);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    // `<legacyKey>-<i>.slot` — the same naming the claim wrote
    if (!name.startsWith(`${legacyKey}-`) || !name.endsWith('.slot')) {
      continue;
    }
    const from = join(dir, name);
    const to = join(dir, `${key}${name.slice(legacyKey.length)}`);
    try {
      if (existsSync(to)) {
        rmSync(from, { force: true });
      } else {
        renameSync(from, to);
      }
    } catch {
      // a file that vanished mid-migration, or a dir we cannot write —
      // the worst case is a stale claim expiring on its TTL
    }
  }
}

/** The legacy-key claim files this call still holds in the kind's
 *  reservations dir — the same `key-i.slot` naming the claim wrote. */
function legacyClaims(
  view: SessionCapView,
  bags: Record<string, Record<string, unknown>>,
  legacyKey: string
): string[] {
  const dir = sessionReservationsDir(view.kind, bags);
  const paths: string[] = [];
  for (let i = 0; i < view.starts; i++) {
    const path = join(dir, `${legacyKey}-${i}.slot`);
    if (existsSync(path)) {
      paths.push(path);
    }
  }
  return paths;
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
  // sha1 as weak-crypto-on-sensitive-data even though the key is not
  // crypto. utf16le keeps lone surrogates distinct (utf8 folds every
  // unpaired half into U+FFFD, so 'x/\ud800' and 'x/\ud801' hashed
  // alike — same claim, cap bypassed); 96 bits keeps two raws that
  // share the 48-char safe prefix from colliding either.
  const digest = createHash('sha256').update(raw, 'utf16le').digest('hex').slice(0, 24);
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
