/**
 * The 'agent' topic — normalized in-turn activity published at the
 * pumpTurn chokepoint (bro-0ppt0). Every ACP turn (conductor pool,
 * fleet acp-worker, judge) funnels through one pump, so one observer
 * here serves every transport; no per-transport patches.
 *
 * Two sinks, both fail-open:
 *
 * - the repo's bus — the live tail. Topics/kinds are normalized so the
 *   broker ring answers "agent last did X" without the consumer knowing
 *   ACP wire shapes. Per-chunk text deltas stay OFF the socket: a busy
 *   turn emits thousands of them and the broker's slow-consumer drop
 *   would make that noise cost real events.
 * - `<git-common>/bro/agents/<agentId>.events.jsonl` — the durable
 *   archive next to the rendered `.log`. Full fidelity: every raw
 *   session/update lands as a row, chunks included, bookended by turn
 *   start/stop. Written only when the process carries a BRO_AGENT_ID
 *   badge — unmanaged turns (conductor sessions, judge calls) have no
 *   agent artifact home and simply don't archive. The file self-caps
 *   like the sibling journals (spec bro-9ti7h): past the byte ceiling
 *   it truncates to its newest whole lines, so a long or chatty
 *   session stays bounded instead of growing forever.
 *
 * Neither sink can fail a turn: publishes are serialized on a settled
 * queue and drain() is capped, file writes are swallowed whole — an
 * observer that throws is a dead observer, not a dead agent.
 */
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { eventsFile, proxyEventsFile, sizeOf } from '@broject/acp-session';
import {
  appendPrivateFileSync,
  busPublish,
  busSocketPath,
  type EventInput,
  mkdirPrivateSync,
  stateCommonDir,
  writePrivateFileSync,
} from '@broject/core';

/** agentIds minted by agent-connectors are filename-safe — a badge
 *  that is not must never become a path segment under bro/agents/.
 *  Same shape the registry itself guards with. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** usage_update ticks per-chunk on some agents — the bus is not a
 *  per-chunk wire, so intermediate counters coalesce at this interval.
 *  The final counters still land at turn stop (stop() flushes the
 *  pending one), so nothing is lost — just decimated in flight. */
export const AGENT_USAGE_THROTTLE_MS = 2_000;

/** Default upper bound on drain() — publishes self-bound at the bus
 *  timeout each, but a wedged half-open socket could still serialize N
 *  events into N×timeout; the drain default keeps a turn's exit prompt.
 *  drain(timeoutMs) may override up to Node's timer maximum; callers
 *  that need a longer bound (e.g. the CI-sensitive worker) pass it
 *  explicitly. */
export const DRAIN_DEFAULT_MS = 3_000;

export interface AgentTurnPlaneOpts {
  /** The session's cwd — resolves the repo's bus socket and the agent
   *  archive under its common dir. Defaults to process.cwd(). */
  cwd?: string;
  /** Provenance label → the envelope's `source` (conductor:<backend>,
   *  "acp provider 'kilo'", …). */
  by: string;
  /** The ACP session id — part of the payload, and the fallback event
   *  `key` when no BRO_AGENT_ID badge is pinned. */
  sessionId: string;
  /** Archive scope — 'agents' (default) keys on the BRO_AGENT_ID badge
   *  and writes `<common>/bro/agents/`; 'proxy' keys on the session id
   *  and writes `<common>/bro/proxy/` even unbadged — a human-run
   *  `bro acp proxy` carries no agent badge (specs/bro-bhyo1.md). */
  plane?: 'agents' | 'proxy';
  /** Provider identity for usage rows, when the caller knows it. */
  provider?: string;
  /** Effective model selected for this turn, when known. */
  model?: string;
}

/** The per-turn observer pumpTurn drives: update() per session/update,
 *  start()/stop() bookends, drain() to settle queued publishes. */
export interface AgentTurnPlane {
  update(u: SessionUpdate): void;
  /** `prompt` — the flattened request text — journals a `kind:'prompt'`
   *  row right after turn start: the archive otherwise carries ZERO
   *  user-side records (session/prompt is RPC, never journaled) and a
   *  pane replaying the file can't say what was asked (spec bro-q2edc). */
  start(prompt?: string): void;
  /** An out-of-band archive row — same file, written outside the update
   *  funnel: a permission verdict is a client-bound exchange the
   *  session/update stream never carries, so a cross-process viewer
   *  only sees it through the journal (spec bro-9qopj). This is the
   *  `agentEventRecord` posture moved onto the plane itself — the
   *  archive the plane already resolved, proxy scope included (an
   *  unbadged `bro acp proxy` journals under `bro/proxy/` where
   *  `agentEventRecord`'s badge requirement would write nothing).
   *  Archive-only, same contract: publishes stay off the bus. */
  note(row: Record<string, unknown>): void;
  stop(stopReason: string | undefined, opts?: { error?: string; replyLen?: number }): void;
  drain(timeoutMs?: number): Promise<void>;
}

const TERMINAL_STATUS = new Set(['completed', 'failed']);

export type Toolish = {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: Array<{ type: string; terminalId?: string }> | null;
};

/** The tool fields consumers need — kind/title/status/terminalId per
 *  the bead, plus the ids and name so a pane can dedupe or label.
 *  Shared by the 'agent' bus topic and the conductor's tool_activity
 *  SSE event (bro-btccj) so both surfaces carry ONE payload shape. */
export function toolPayload(u: Toolish, phase: 'open' | 'finish'): Record<string, unknown> {
  const p: Record<string, unknown> = { phase, toolCallId: u.toolCallId };
  if (typeof u.title === 'string' && u.title !== '') p['title'] = u.title;
  if (typeof u.name === 'string' && u.name !== '') p['name'] = u.name;
  if (typeof u.kind === 'string' && u.kind !== '') p['kind'] = u.kind;
  if (typeof u.status === 'string' && u.status !== '') p['status'] = u.status;
  // terminalId rides in tool content ({type:'terminal'}) on the ACP
  // wire — surface the first one so consumers can point at the
  // terminal registry (bro-eua0d) without knowing the content shape
  const terminal = (u.content ?? []).find(
    c => c.type === 'terminal' && typeof c.terminalId === 'string'
  );
  if (terminal !== undefined) p['terminalId'] = terminal.terminalId;
  return p;
}

/** The turn-plane archive path — 'proxy' keys on the session id under
 *  `bro/proxy/` (`-p<pid>` keeps two concurrent proxy runs of the same
 *  session id — a reconnect, a duplicated client — from mixing rows in
 *  one archive); 'agents' keys on the agent badge under `bro/agents/`.
 *  Undefined when the run can't resolve a git common dir or (agents
 *  scope) carries no badge. */
const archiveFile = (
  scope: 'agents' | 'proxy',
  common: string | null,
  agentId: string | undefined,
  sessionId: string
): string | undefined => {
  if (common === null) {
    return undefined;
  }
  if (scope === 'proxy') {
    return proxyEventsFile(common, sessionId, process.pid);
  }
  return agentId === undefined ? undefined : eventsFile(common, agentId);
};

/** The archive's self-cap bound (spec bro-9ti7h) — the lifecycle
 *  journal's 4/2 MiB pair. The archive is the durable record behind a
 *  windowed reader (TAIL_BYTES opens), so the kept tail outlasts any
 *  consumer's scrollback while the file stays cheap to tail.
 *  KEEP < MAX is the invariant the cap math relies on. */
export const AGENT_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_ARCHIVE_KEEP_BYTES = 2 * 1024 * 1024;

/** O_NOFOLLOW where the platform has it — the cap's tail read refuses
 *  a path swapped to a symlink exactly like the private write seam
 *  does. Absent on win32, where the profile ACL owns the guarantee
 *  (private-files.ts's own posture). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Cap one archive to its newest whole lines (spec bro-9ti7h):
 *
 *  - READ through one NOFOLLOW fd — a path swapped to a symlink is
 *    refused like the write seam refuses it, and the open pins the
 *    instance so a racing resize reads honest offsets. The read runs
 *    to the fd's own EOF, not the first stat's: rows appended mid-cap
 *    land inside the kept tail instead of being renamed away (the
 *    bound stretches to cover them — newest data always wins).
 *  - KEEP only complete JSONL rows — the slice's first line can be
 *    torn mid-row and drops; no newline at all means the whole tail
 *    is one unparseable fragment (a single row bigger than the keep
 *    window), which is dead weight, not data — the archive converges
 *    to empty and grows fresh rows.
 *  - REPLACE via a staged private write + atomic rename — the archive
 *    is never empty or partial: a kill mid-cap leaves the OLD file
 *    whole or the NEW one, never a truncated middle (an in-place
 *    truncate+write can't say that). No consumer holds the archive's
 *    fd — every reader opens per poll — so the inode swap strands
 *    nothing, and the staged tmp is pinned 0600 by the same seam as
 *    the append.
 *
 *  Bounded memory throughout — a pre-existing giant archive converges
 *  on its next write without a whole-file read. Runs inside the
 *  caller's try — housekeeping never outranks the row. */
const capArchive = (file: string): void => {
  if (sizeOf(file) <= AGENT_ARCHIVE_MAX_BYTES) {
    return;
  }
  const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  let tail: Buffer;
  try {
    const sz = fstatSync(fd).size;
    if (sz <= AGENT_ARCHIVE_MAX_BYTES) {
      return; // a concurrent cap already shrank the file
    }
    const from = sz - AGENT_ARCHIVE_KEEP_BYTES;
    const parts: Buffer[] = [];
    let at = from;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const n = readSync(fd, chunk, 0, chunk.length, at);
      if (n === 0) {
        break;
      }
      parts.push(chunk.subarray(0, n));
      at += n;
      // a runaway same-file appender can't stretch the read forever —
      // beyond one extra MAX the tail is let go, still bounded
      if (at - from > AGENT_ARCHIVE_MAX_BYTES) {
        break;
      }
    }
    const slice = Buffer.concat(parts);
    const nl = slice.indexOf(0x0a);
    tail = nl >= 0 ? slice.subarray(nl + 1) : Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
  const staged = `${file}.cap-${process.pid}`;
  try {
    writePrivateFileSync({ path: staged, data: tail });
    renameSync(staged, file);
  } finally {
    rmSync(staged, { force: true }); // a no-op once the rename landed
  }
};

/** Append one archive row, then self-cap — the ONE helper every writer
 *  funnels through so the bound rides the plane's
 *  start/update/note/stop funnel and agentEventRecord's out-of-band
 *  row alike. One statSync per row, the otel sink's own shape —
 *  proportional next to the open/write/close the append already pays. */
const appendArchiveRow = (file: string, line: string): void => {
  appendPrivateFileSync({ path: file, data: line });
  capArchive(file);
};

/** An out-of-band archive row — same file, same shape, written outside
 *  pumpTurn's update funnel (spec bro-l8wqu). The one consumer today is
 *  the acp-worker's permission handler: `session/request_permission` is
 *  a client-bound request, never a session/update notification, so a
 *  cross-process viewer only sees it if the worker records it here.
 *  Unbadged processes archive nothing — same posture as the plane. */
export function agentEventRecord(
  cwd: string,
  sessionId: string,
  by: string,
  row: Record<string, unknown>
): void {
  const badge = process.env.BRO_AGENT_ID?.trim();
  const agentId =
    badge !== undefined && badge !== '' && SAFE_AGENT_ID.test(badge) ? badge : undefined;
  const file = archiveFile(
    'agents',
    agentId === undefined ? null : stateCommonDir(cwd),
    agentId,
    sessionId
  );
  if (file === undefined) return;
  try {
    mkdirPrivateSync({ path: dirname(file) });
    appendArchiveRow(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), session: sessionId, by, key: agentId, ...row })}\n`
    );
  } catch {
    /* the archive is telemetry — a disk failure never fails a turn */
  }
}

/** The plane for one turn — resolved sinks are computed once so the
 *  per-update cost is a Map lookup plus a queued socket write. */
export function agentTurnPlane(opts: AgentTurnPlaneOpts): AgentTurnPlane {
  const cwd = opts.cwd ?? process.cwd();
  const badge = process.env.BRO_AGENT_ID?.trim();
  const agentId =
    badge !== undefined && badge !== '' && SAFE_AGENT_ID.test(badge) ? badge : undefined;
  const cause = process.env.BRO_BEAD_ID?.trim() || undefined;
  // unbadged turns key by session so consumers can still pin one —
  // the 'acp:' prefix keeps the namespace from colliding with real ids
  const key = agentId ?? `acp:${opts.sessionId}`;
  const socket = busSocketPath(cwd);
  const scope = opts.plane ?? 'agents';
  const common = agentId !== undefined || scope === 'proxy' ? stateCommonDir(cwd) : null;
  const file = archiveFile(scope, common, agentId, opts.sessionId);

  let queue: Promise<unknown> = Promise.resolve();
  const seenTools = new Set<string>();
  const doneTools = new Set<string>();
  const seenSubs = new Set<string>();
  let lastUsageAt = 0;
  let pendingUsage: Record<string, unknown> | undefined;

  const emit = (kind: string, payload: Record<string, unknown>): void => {
    if (socket === null) {
      return;
    }
    const event: EventInput = {
      topic: 'agent',
      kind,
      key,
      source: opts.by,
      ...(cause !== undefined ? { cause } : {}),
      payload,
    };
    // serialized — publish order IS arrival order on the ring, so an
    // 'open' must never overtake its own turn's 'start'
    queue = queue.then(() => busPublish(socket, event));
  };

  let dirReady = false;
  const record = (row: Record<string, unknown>): void => {
    if (file === undefined) {
      return;
    }
    try {
      // mkdir once — the dir is stable for the plane's life. The
      // archive carries raw ACP prompts and replies: pinned owner-only
      // (spec bro-l8c4f.4) like the bus socket and state files — a 022
      // umask would leave it 0644, readable by every local user without
      // the token-gated route. Repair rides EVERY row, not just the
      // first — in a dir another user can write, a swapped-in
      // permissive file between rows must never collect the next row
      if (!dirReady) {
        mkdirPrivateSync({ path: dirname(file) });
        dirReady = true;
      }
      appendArchiveRow(file, `${JSON.stringify(row)}\n`);
    } catch {
      /* the archive is telemetry — a disk failure never fails a turn */
    }
  };

  const stamp = (): Record<string, unknown> => ({
    ts: new Date().toISOString(),
    session: opts.sessionId,
    by: opts.by,
    key,
    ...(cause === undefined ? {} : { bead: cause }),
  });

  const emitUsage = (): void => {
    if (pendingUsage !== undefined) {
      const p = pendingUsage;
      pendingUsage = undefined;
      emit('usage', p);
      lastUsageAt = Date.now();
    }
  };

  /** A pending counter must not pin stale numbers through a long quiet
   *  stretch — it rides the next non-usage update once the throttle
   *  window has elapsed (the stop() flush stays the last resort). */
  const flushUsageIfDue = (): void => {
    if (pendingUsage !== undefined && Date.now() - lastUsageAt >= AGENT_USAGE_THROTTLE_MS) {
      emitUsage();
    }
  };

  const onToolCall = (u: Toolish): void => {
    const terminal = u.status !== undefined && u.status !== null && TERMINAL_STATUS.has(u.status);
    // a duped terminal edge re-announces a landing, never a new edge —
    // the conductor's LiveTurn dedupes identically (one finish per call)
    if (terminal && doneTools.has(u.toolCallId)) return;
    const fresh = !seenTools.has(u.toolCallId);
    if (fresh) seenTools.add(u.toolCallId);
    // a mid-flight repeat of an already-open call is churn — only
    // lifecycle edges (open, finish) go on the wire
    if (!fresh && !terminal) return;
    if (fresh && terminal) {
      // a call first seen already-terminal still needs its open edge —
      // consumers pair open→finish and a bare finish orphans the row
      const openEdge = toolPayload(u, 'open');
      delete openEdge['status'];
      emit('tool_call', openEdge);
    }
    if (terminal) doneTools.add(u.toolCallId);
    emit('tool_call', toolPayload(u, terminal ? 'finish' : 'open'));
  };

  const onToolCallUpdate = (u: Toolish): void => {
    const terminal = u.status != null && TERMINAL_STATUS.has(u.status);
    if (!terminal || doneTools.has(u.toolCallId)) return;
    seenTools.add(u.toolCallId);
    doneTools.add(u.toolCallId);
    emit('tool_call', toolPayload(u, 'finish'));
  };

  const onSubagent = (u: {
    sessionId: string;
    title?: string | null;
    description?: string | null;
  }): void => {
    const fresh = !seenSubs.has(u.sessionId);
    if (fresh) seenSubs.add(u.sessionId);
    const p: Record<string, unknown> = {
      phase: fresh ? 'open' : 'update',
      sessionId: u.sessionId,
    };
    if (typeof u.title === 'string' && u.title !== '') p['title'] = u.title;
    if (typeof u.description === 'string' && u.description !== '') {
      p['description'] = u.description;
    }
    emit('subagent', p);
  };

  const onUsage = (u: {
    used?: unknown;
    size?: unknown;
    cost?: { amount?: unknown } | null;
  }): void => {
    const p: Record<string, unknown> = { used: u.used, size: u.size };
    if (u.cost != null && typeof u.cost.amount === 'number') {
      p['cost'] = u.cost;
    }
    if (Date.now() - lastUsageAt >= AGENT_USAGE_THROTTLE_MS) {
      // a window-passed tick emits directly — any older pending one is
      // stale by definition (this counter is newer)
      pendingUsage = undefined;
      emit('usage', p);
      lastUsageAt = Date.now();
    } else {
      pendingUsage = p;
    }
  };

  const recordUsage = (u: SessionUpdate): void => {
    if (u.sessionUpdate !== 'usage_update') return;
    const raw = u as unknown as Record<string, unknown>;
    const number = (key: string): number | undefined => {
      const value = raw[key];
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
    };
    const cost = raw['cost'];
    const amount =
      typeof cost === 'object' && cost !== null
        ? (cost as Record<string, unknown>)['amount']
        : undefined;
    const currency =
      typeof cost === 'object' && cost !== null
        ? (cost as Record<string, unknown>)['currency']
        : undefined;
    record({
      ...stamp(),
      kind: 'usage',
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(number('used') === undefined ? {} : { tokens: number('used') }),
      ...(number('inputTokens') === undefined ? {} : { inputTokens: number('inputTokens') }),
      ...(number('outputTokens') === undefined ? {} : { outputTokens: number('outputTokens') }),
      ...(currency === 'USD' && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
        ? { costUsd: amount }
        : {}),
      usage: raw,
    });
  };

  return {
    start(prompt?: string) {
      record({ ...stamp(), kind: 'turn', phase: 'start' });
      emit('turn', { phase: 'start', sessionId: opts.sessionId });
      if (prompt !== undefined && prompt !== '') {
        record({ ...stamp(), kind: 'prompt', text: prompt });
        // the bus gets the compact form — the archive holds the full
        // body; a reader needing the whole prompt reads the file
        emit('prompt', { sessionId: opts.sessionId, text: prompt.slice(0, 200) });
      }
    },

    note(row) {
      record({ ...stamp(), ...row });
    },

    update(u) {
      // the durable row is the full-fidelity record — every update,
      // chunks included, written BEFORE the bus sees the filtered view
      record({ ...stamp(), kind: 'update', update: u });
      recordUsage(u);
      if (u.sessionUpdate !== 'usage_update') flushUsageIfDue();
      switch (u.sessionUpdate) {
        case 'tool_call':
          onToolCall(u);
          return;
        case 'tool_call_update':
          onToolCallUpdate(u);
          return;
        case 'subagent_update':
          onSubagent(u);
          return;
        case 'usage_update':
          onUsage(u);
          return;
        default:
          // text deltas and the rest stay off the bus — the archive
          // row above already holds them for the durable record
          return;
      }
    },

    stop(stopReason, o = {}) {
      record({
        ...stamp(),
        kind: 'turn',
        phase: 'stop',
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(o.error !== undefined ? { error: o.error } : {}),
      });
      // usage precedes stop on the wire — chronology, and consumers
      // reading 'turn stop' can trust the final counters already landed
      emitUsage();
      const p: Record<string, unknown> = { phase: 'stop', sessionId: opts.sessionId };
      if (stopReason !== undefined) p['stopReason'] = stopReason;
      if (o.error !== undefined) p['error'] = o.error;
      if (o.replyLen !== undefined) p['replyLen'] = o.replyLen;
      emit('turn', p);
    },

    async drain(timeoutMs?: number) {
      const cap =
        timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.min(timeoutMs, 2_147_483_647)
          : DRAIN_DEFAULT_MS;
      await Promise.race([
        queue.then(() => undefined),
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, cap);
          t.unref?.();
        }),
      ]);
    },
  };
}
