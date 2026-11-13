/**
 * The production accept `emit` transport (specs/bro-qjji2.11.md) —
 * delivers the evidence bundle to the run's recorded customer
 * channel. `acceptStage` re-emits on every wake while the verdict is
 * absent (the first emit may have died inside the pending intent's
 * crash window), so this adapter's contract is idempotency: the same
 * bundle for the same (runId, stage) must never double-deliver.
 *
 * Routing — the customer identity picks the channel:
 *
 *   agent → the A2A surface: `sendSessionMessage` (the `bro msg`
 *     core) — ledger-resolved sessions on inbox-capable hosts get the
 *     F4 inbox file plus an events `msg` record; everyone else gets
 *     the addressed mailbox drop (`to:` the mailbox vocabulary) plus
 *     the same record. "Agent" means the identity names a session or
 *     agent address: the `orchestrator` role, `<host>:<sid>` session
 *     key shape, a fleet-registry agentId, or a ledger-resolved
 *     session (spawnedBy agentId, sid, unique sid prefix).
 *
 *   user → notify/mailbox: one `topic:'notify'` `kind:'ask'` event
 *     through the `events` facade — the same surface `bro notify`
 *     writes, broadcast (no `to`): the mailbox's contract is
 *     every-live-session delivery, which is what a human customer
 *     needs — there is no "user" address in the vocabulary, and an
 *     addressed drop to a bare name would reach nobody.
 *
 * Classification fails SAFE toward the user leg: an identity that
 * resolves nowhere is a human label, and broadcast reaches every
 * live session — including an agent session that drains the mailbox.
 * The reverse mistake would strand the bundle on an address no
 * session carries. An agent-classified customer whose delivery
 * lands nowhere is NOT re-routed to broadcast — evidence must not
 * leak to sessions the customer did not name; the emit warns and
 * leaves the sentinel unwritten so the next wake retries.
 *
 * Idempotency — the sentinel ledger sits beside the pipeline plane
 * (`.emit-<runId>-<stage>-<digest>`; the notify dir when no plane
 * resolves). The digest is `contentDigest(bundle)`: within one
 * pending accept entry the bundle is content-stable, so every
 * `recheck` re-emit computes the same key and dedupes — the
 * (runId, stage) contract the stage documents. The digest earns its
 * place on RE-ENTRY: `rejected → work` returns to accept with fresh
 * verify rows — a different bundle, a different key — so the
 * customer sees the new evidence instead of the second emit being
 * swallowed by a (runId, stage)-forever sentinel.
 *
 * The same key rides the published event's `key`, so the mailbox
 * transport's coalesceDrops collapses pending same-key drops — the
 * crash-window double-emit (delivery landed, sentinel write died)
 * supersedes rather than accumulates.
 *
 * Ordering is at-least-once, never at-most-once: the sentinel is
 * written only AFTER a leg reports delivery. A transport failure
 * leaves no sentinel and the next wake retries; a crash between
 * delivery and sentinel re-delivers once (the contract's tolerated
 * duplicate, coalesced on the mailbox leg). A sentinel WRITE failure
 * warns and moves on — noisy re-delivery beats a lost bundle.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentRegistryEntry,
  type EventsFacade,
  type EventInput,
  facade,
  type LedgerFacade,
  loadConfig,
  notifyDir,
  readAgentRegistry,
} from '@broject/core';
import { type EvidenceBundle, contentDigest, pipelineDir, type StageCall } from '@broject/pipeline';
import {
  type MsgSessionRow,
  resolveMsgTarget,
  sendSessionMessage,
  sessionMsgRows,
} from './commands/session-msg.ts';

/** The emit seam's signature — `AcceptDeps.emit` wants
 *  `(call, bundle) => MaybePromise<void>`; this adapter is async
 *  because the A2A leg awaits the ledger and the events publish. */
export type PipelineEmit = (call: StageCall, bundle: EvidenceBundle) => Promise<void>;

export interface PipelineEmitDeps {
  /** repo dir — resolves the pipeline plane, the notify mailbox, the
   *  session ledger, and the events transport */
  dir: string;
  /** env for inbox paths + source attribution — default process.env */
  env?: NodeJS.ProcessEnv;
  /** test seams — production resolves both through `facade()` so a
   *  `connectors.ledger`/`connectors.events` pin is honored */
  ledger?: LedgerFacade;
  events?: EventsFacade;
  /** test seam — defaults to the real sendSessionMessage */
  sendMessage?: typeof sendSessionMessage;
  /** test seam — defaults to readAgentRegistry(dir); a throwing
   *  registry degrades to "no known agentIds", never a failed emit */
  registry?: () => Record<string, AgentRegistryEntry>;
  /** warning sink — default console.error (the emit runs inside a
   *  pipeline drive; a warning must never become a throw) */
  warn?: (msg: string) => void;
}

/** `<host>:<sid>` session-key shape — the only customer-id grammar
 *  that is agent-addressed by construction (a `:` never appears in a
 *  bdActor/git-user identity). */
const SESSION_KEY_RE = /^[^\s:]+:[^\s:]+$/;

/** The dedup key's content half — 12 hex chars of the bundle digest:
 *  collision-free at pipeline scale, readable in a filename. */
const digestOf = (bundle: EvidenceBundle): string => contentDigest(bundle).slice(0, 12);

/** The coalescing/sentinel key — run + stage + bundle content. */
const dedupKey = (call: StageCall, bundle: EvidenceBundle): string =>
  `pipeline-accept:${call.runId}:${call.stage.name}:${digestOf(bundle)}`;

/** `.emit-<runId>-<stage>-<digest>` beside the pipeline plane — the
 *  notify dir when no plane resolves (the run itself needs the
 *  plane, so the fallback only serves plane-less drives). */
function sentinelPath(dir: string, call: StageCall, bundle: EvidenceBundle): string {
  const plane = pipelineDir({ dir }) ?? notifyDir(dir);
  return join(plane, `.emit-${call.runId}-${call.stage.name}-${digestOf(bundle)}`);
}

/** The bundle text — the proven wording: run, item, the full
 *  journaled bundle (the customer signs what the journal can prove —
 *  never a truncated view), and the verdict command. */
function bundleText(call: StageCall, bundle: EvidenceBundle): string {
  return (
    `pipeline run ${call.runId} reached the accept gate for ${call.item}.\n\n` +
    `Evidence bundle:\n${JSON.stringify(bundle, null, 2)}\n\n` +
    `Record the customer's verdict: bro pipeline accept ${call.item} <accepted|rejected|abandon>`
  );
}

/** The publisher identity — the `bro msg` attribution rule:
 *  BRO_AGENT_ID badge first, then BRO_SESSION_ID; a session with
 *  neither stays anonymous rather than claim a role. */
function emitSource(env: NodeJS.ProcessEnv): string | undefined {
  const agentId = env.BRO_AGENT_ID;
  if (agentId !== undefined && agentId !== '') {
    return agentId;
  }
  const sessionId = env.BRO_SESSION_ID;
  if (sessionId !== undefined && sessionId !== '') {
    return sessionId;
  }
  return undefined;
}

/** `facade('events')` honoring the connectors.* pins — undefined
 *  only when resolution itself throws (the mailbox connector is
 *  registered unconditionally, so this is a broken-config state,
 *  reported through warn, never a crashed emit). */
function resolveEvents(
  dir: string,
  deps: PipelineEmitDeps,
  warn: (msg: string) => void
): EventsFacade | undefined {
  if (deps.events !== undefined) {
    return deps.events;
  }
  try {
    const prefer = loadConfig(dir).connectors;
    return facade('events', { dir }, prefer === undefined ? {} : { prefer });
  } catch (e) {
    warn(
      `pipeline-emit: events facade unavailable — ${e instanceof Error ? e.message : String(e)}`
    );
    return undefined;
  }
}

/** `facade('ledger')` — same pin contract; undefined degrades
 *  classification to grammar+registry (a bare agentId then reads as
 *  a user label → broadcast, which still reaches its session). */
function resolveLedger(dir: string, deps: PipelineEmitDeps): LedgerFacade | undefined {
  if (deps.ledger !== undefined) {
    return deps.ledger;
  }
  try {
    const prefer = loadConfig(dir).connectors;
    return facade('ledger', { dir }, prefer === undefined ? {} : { prefer });
  } catch {
    return undefined;
  }
}

/** The session rows the classification consults — undefined when no
 *  ledger resolves or the read fails (same degrade as `bro msg`'s
 *  ledger leg: resolve by the cheaper planes). */
async function ledgerRows(
  ledger: LedgerFacade | undefined,
  warn: (msg: string) => void
): Promise<MsgSessionRow[] | undefined> {
  if (ledger === undefined) {
    return undefined;
  }
  try {
    const res = await sessionMsgRows(ledger, {});
    for (const w of res.warnings) {
      warn(w);
    }
    return res.rows;
  } catch (e) {
    warn(
      `pipeline-emit: session ledger unreadable — agent classification ` +
        `degrades to grammar+registry (${e instanceof Error ? e.message : String(e)})`
    );
    return undefined;
  }
}

/** The fleet registry's agentIds — a spawned worker whose session
 *  has not hooked yet is still an agent customer. A torn registry
 *  reads as empty (the ledger leg still covers live sessions). */
function registryAgentIds(dir: string, deps: PipelineEmitDeps): string[] {
  try {
    const reg = (deps.registry ?? (() => readAgentRegistry(dir)))();
    return Object.values(reg).map(e => e.agentId);
  } catch {
    return [];
  }
}

/** Does the customer identity name an agent/session address? The
 *  checks mirror `resolveMsgTarget`'s grammar so "agent" here means
 *  "sendSessionMessage would resolve this to real sessions" — plus
 *  the addresses resolution cannot see: the orchestrator role with
 *  no live rows, and a registry agentId with no hooked session yet.
 *  `undefined` rows (no ledger) simply skip the ledger leg. */
function isAgentCustomer(
  customer: string,
  rows: MsgSessionRow[] | undefined,
  agentIds: readonly string[]
): boolean {
  if (customer === 'orchestrator' || SESSION_KEY_RE.test(customer)) {
    return true;
  }
  if (agentIds.includes(customer)) {
    return true;
  }
  if (rows !== undefined) {
    const res = resolveMsgTarget(rows, customer);
    if (res.deliveries.some(d => d.session !== undefined)) {
      return true;
    }
  }
  return false;
}

/** One emit's resolved context — the legs take this instead of a
 *  positional arg list (codescene: excess function arguments). */
interface EmitCtx {
  call: StageCall;
  text: string;
  key: string;
  deps: PipelineEmitDeps;
  env: NodeJS.ProcessEnv;
  ledger: LedgerFacade | undefined;
  events: EventsFacade | undefined;
  send: typeof sendSessionMessage;
  warn: (msg: string) => void;
}

/** The A2A leg — sendSessionMessage owns per-session channel choice
 *  (inbox file vs addressed mailbox drop) and the events record.
 *  Returns true when at least one leg landed delivery. */
async function deliverAgent(customer: string, ctx: EmitCtx): Promise<boolean> {
  const res = await ctx.send({
    dir: ctx.deps.dir,
    env: ctx.env,
    target: customer,
    text: ctx.text,
    kind: 'ask',
    inReplyTo: ctx.call.runId,
    key: ctx.key,
    ...(ctx.ledger !== undefined ? { ledger: ctx.ledger } : {}),
    ...(ctx.events !== undefined ? { events: ctx.events } : {}),
  });
  for (const w of res.warnings) {
    ctx.warn(w);
  }
  if (res.error !== undefined) {
    ctx.warn(`pipeline-emit: ${res.error} — bundle not delivered`);
  }
  return res.deliveries.some(d => d.inboxPath !== undefined || d.published);
}

/** The user leg — one broadcast `notify`/`ask` event through the
 *  events facade (the `bro notify` surface). Returns the publish
 *  result's `published` flag. */
async function deliverUser(ctx: EmitCtx): Promise<boolean> {
  if (ctx.events === undefined) {
    ctx.warn('pipeline-emit: no events transport — evidence bundle not delivered');
    return false;
  }
  const source = emitSource(ctx.env);
  const event: EventInput = {
    topic: 'notify',
    kind: 'ask',
    payload: ctx.text,
    key: ctx.key,
    cause: ctx.call.runId,
    ...(source !== undefined ? { source } : {}),
  };
  const res = await ctx.events.publish(event);
  if (!res.published) {
    ctx.warn(`pipeline-emit: notify publish failed — ${res.reason ?? 'unknown reason'}`);
    return false;
  }
  return true;
}

/**
 * Build the production `emit` binding for `acceptStage`. Delivery is
 * at-least-once: the sentinel is written only after a leg reports
 * delivery, so a transport failure retries on the next wake's
 * recheck; a crash between delivery and sentinel re-delivers once
 * (coalesced on the mailbox leg). Dedup is content-scoped — see the
 * module doc for why the key carries the bundle digest.
 */
export function pipelineEmit(deps: PipelineEmitDeps): PipelineEmit {
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const env = deps.env ?? process.env;
  const send = deps.sendMessage ?? sendSessionMessage;
  return async (call: StageCall, bundle: EvidenceBundle): Promise<void> => {
    // acceptStage's customerGate runs before emit — a run with no
    // recorded customer never reaches here. The defensive check keeps
    // the fail-closed contract if the seam is ever invoked directly:
    // evidence must not leak to a gate nobody can sign through.
    const customer = call.customer;
    if (customer === undefined || customer === '') {
      warn(`pipeline-emit: run ${call.runId} has no recorded customer — bundle not delivered`);
      return;
    }
    const sentinel = sentinelPath(deps.dir, call, bundle);
    if (existsSync(sentinel)) {
      return; // this exact bundle already delivered — recheck dedup
    }
    const key = dedupKey(call, bundle);
    const text = bundleText(call, bundle);
    const events = resolveEvents(deps.dir, deps, warn);
    const ledger = resolveLedger(deps.dir, deps);
    const rows = await ledgerRows(ledger, warn);
    const agent = isAgentCustomer(customer, rows, registryAgentIds(deps.dir, deps));
    const ctx: EmitCtx = {
      call,
      text,
      key,
      deps,
      env,
      ledger,
      events,
      send,
      warn,
    };
    const landed = agent ? await deliverAgent(customer, ctx) : await deliverUser(ctx);
    if (!landed) {
      return; // no sentinel — the next wake's recheck retries
    }
    try {
      // the plane dir may not exist yet on a degenerate drive — the
      // sentinel is the dedup ledger, so it must be writable
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, `${new Date().toISOString()}\n`);
    } catch (e) {
      warn(
        `pipeline-emit: sentinel write failed (${e instanceof Error ? e.message : String(e)}) — ` +
          `the bundle may re-deliver on recheck`
      );
    }
  };
}
