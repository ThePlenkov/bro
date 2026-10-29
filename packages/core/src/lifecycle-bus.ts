/**
 * The bus mirror of the lifecycle journal — `worker.*` / `worktree.*`
 * envelopes for the transitions `emitLifecycle` records (spec
 * specs/bro-294hf.md).
 *
 * Why a mirror and not a reader: the journal is a file — append-only,
 * no subscribers. The bus already carries topics, subscriber filters
 * and seq cursors; the journal already collects the real transition
 * points (`spawn` admission, the `agent-exit` harvest, every worktree
 * add/remove). Mapping the row to an envelope at the one writer every
 * surface shares covers all of them — including call sites this bead
 * has never heard of.
 *
 * Why `busPublish` and not `facade('events')`: the facade's default
 * connector is the session mailbox — a drop per transition is fleet
 * noise in session context, the very thing notify coalescing exists to
 * prevent. The bus is the opt-in observational plane: broker down is a
 * routine `published:false`, and every emit here is fire-and-forget —
 * the command that landed the transition never waits on the feed that
 * reports it.
 */
import { busPublish, busSocketPath, busSocketPathForCommon } from './bus.ts';
import type { EventInput } from './events.ts';
import type { LifecycleEvent } from './lifecycle.ts';

type Detail = Record<string, unknown> | undefined;

/** detail[k] as a usable string, else undefined — an empty-string
 *  detail field is malformed, not a value (same rule isEventInput
 *  enforces on the envelope). */
function str(detail: Detail, k: string): string | undefined {
  const v = detail?.[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(detail: Detail, k: string): number | undefined {
  const v = detail?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** payload[k] = v only when v is present — the shared
 *  set-if-defined every mapper uses instead of inline ifs. */
function setIf(payload: Record<string, unknown>, k: string, v: unknown): void {
  if (v !== undefined) payload[k] = v;
}

/** detail fields lifted verbatim into the payload when present. */
function copyDetail(payload: Record<string, unknown>, detail: Detail, keys: readonly string[]): void {
  for (const k of keys) {
    setIf(payload, k, str(detail, k));
  }
}

/** The payload skeleton every worker/worktree row shares: the subject
 *  id plus the bead it ran for. */
function subjectPayload(ev: LifecycleEvent, id: string, idKey: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { [idKey]: id };
  setIf(payload, 'bead', ev.bead);
  return payload;
}

/** `spawn` → `worker.spawned` — admission is committed; the attempt's
 *  runId/log/worktree ride the payload. */
function workerSpawnEvent(ev: LifecycleEvent, via: string): EventInput | undefined {
  const agent = str(ev.detail, 'agent');
  if (agent === undefined) {
    return undefined;
  }
  const payload = subjectPayload(ev, agent, 'agentId');
  copyDetail(payload, ev.detail, [
    'runId',
    'worktree',
    'log',
    'backend',
    'provider',
    'model',
    'class',
  ]);
  const worktree = str(ev.detail, 'worktree');
  return {
    topic: 'worker',
    kind: 'spawned',
    key: agent,
    source: via,
    ...(worktree !== undefined ? { ref: worktree } : {}),
    payload,
  };
}

/** `agent-exit` → `worker.exited` — the classified code/cause plus the
 *  attempt token. actor carries the agentId on this kind (the exit is
 *  the agent's own record); detail.agent is the same fact when present. */
function workerExitEvent(ev: LifecycleEvent, via: string): EventInput | undefined {
  const agent = str(ev.detail, 'agent') ?? (ev.actor === '' ? undefined : ev.actor);
  if (agent === undefined) {
    return undefined;
  }
  const payload = subjectPayload(ev, agent, 'agentId');
  setIf(payload, 'code', num(ev.detail, 'code'));
  copyDetail(payload, ev.detail, ['runId', 'cause', 'backend', 'provider', 'model', 'log']);
  const log = str(ev.detail, 'log');
  return {
    topic: 'worker',
    kind: 'exited',
    key: agent,
    source: via,
    ...(log !== undefined ? { ref: log } : {}),
    payload,
  };
}

/** `worktree` → `worktree.added`/`removed` — `to` drives the kind
 *  (removed) or stays `added` (created/reused); the path is the subject
 *  a subscriber's `keys` filter selects. */
function worktreeEvent(ev: LifecycleEvent, via: string): EventInput | undefined {
  const path = str(ev.detail, 'worktree');
  if (path === undefined) {
    return undefined;
  }
  const payload = subjectPayload(ev, path, 'path');
  setIf(payload, 'branch', str(ev.detail, 'branch'));
  return {
    topic: 'worktree',
    kind: ev.to === 'removed' ? 'removed' : 'added',
    key: path,
    source: via,
    ref: path,
    payload,
  };
}

const KIND_MAPPER: Record<string, (ev: LifecycleEvent, via: string) => EventInput | undefined> = {
  spawn: workerSpawnEvent,
  'agent-exit': workerExitEvent,
  worktree: worktreeEvent,
};

/** Map a lifecycle journal row to its bus envelope — `undefined` for
 *  kinds the worker/worktree feed does not cover (claim, gate, verdict,
 *  merge, …): they stay journal-only until a consumer needs them.
 *
 *  Field roles: `key` is the subject (agentId for a worker, the path
 *  for a worktree) — what a subscriber's `keys` filter selects.
 *  `source` is the row's writing surface (`detail.via`). The lifecycle
 *  `to` (target *state*) is deliberately not the envelope `to`
 *  (recipient *address*) — mapping it would address every event to a
 *  phantom and hide it from broadcast subscribers. */
export function lifecycleBusEvent(ev: LifecycleEvent): EventInput | undefined {
  const via = str(ev.detail, 'via') ?? 'lifecycle';
  return KIND_MAPPER[ev.kind]?.(ev, via);
}

/** Mirror one journal row onto the bus — fire-and-forget inside
 *  `emitLifecycle`'s own fail-open frame. `common` is the git common
 *  dir the journal already resolved, so the emit costs no second git
 *  probe. `unref` keeps a wedged broker from extending the publishing
 *  process's lifetime — the journal row is already durable. */
export function publishLifecycleBusEvent(common: string, ev: LifecycleEvent): void {
  try {
    const input = lifecycleBusEvent(ev);
    if (input !== undefined) {
      void busPublish(busSocketPathForCommon(common), input, { unref: true }).catch(() => {});
    }
  } catch {
    // the feed never makes the transition it reports a failure
  }
}

/** `worker.silent` — the one feed event with no journal row: silence
 *  is a derived level (log mtime age), not a recorded transition. The
 *  caller is the existing silence computation (watch's tick); this is
 *  the emit, not the poller — same fire-and-forget contract. */
export function emitWorkerSilent(
  dir: string,
  input: { bead: string; silentMin: number; agentId?: string; log?: string }
): void {
  try {
    const socket = busSocketPath(dir);
    if (socket === null) {
      return;
    }
    // an empty agentId is absent, not a key — '' would fail isEventInput
    // and the event would drop silently at the broker door
    const agentId = input.agentId === '' ? undefined : input.agentId;
    const payload: Record<string, unknown> = { bead: input.bead, silentMin: input.silentMin };
    setIf(payload, 'agentId', agentId);
    void busPublish(
      socket,
      {
        topic: 'worker',
        kind: 'silent',
        key: agentId ?? input.bead,
        source: 'watch',
        ...(input.log !== undefined && input.log !== '' ? { ref: input.log } : {}),
        payload,
      },
      { unref: true }
    ).catch(() => {});
  } catch {
    // advisory — a dead broker must not stall the tick
  }
}
