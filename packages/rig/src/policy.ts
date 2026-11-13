/** `Policy` — the lifecycle contract every rig policy implements
 *  (spec bro-oy3k1.1 §Policies; bro-u6fp5). loop/drive/convoy are
 *  `{predicate → action}` sets over item state evaluated over the
 *  engine — this interface names the four transition kinds every work
 *  item can take:
 *
 *    select → onGate / onPark / onLost
 *
 *  `queued → claimed → working → pr_open → gate_blocked → merged →
 *  closed`, with `park` and `lost` reachable from any active state.
 *
 *  The generics are the policy's own: `I` its work item, `C` its world
 *  (deps + config — the IO adapters the command injects), `V` the
 *  verdict/action its FSM consumes. The interface names the lifecycle
 *  moments; each policy's verdict vocabulary is its own — convoy's
 *  `done`/`failed`/`stopped`/`occupied`/`blocked`/`error` ride the
 *  same `V` channel and are not all named transitions. Methods may be
 *  sync or async — the driver awaits either. */
export interface Policy<I = unknown, C = unknown, V = unknown> {
  /** select — pick the next item to advance, or `undefined` when the
   *  queue is drained or fully gated. Durable-state reads only: a
   *  policy never waits inside select. */
  select(ctx: C): I | undefined | Promise<I | undefined>;
  /** onGate — the item reached or sits at a gate (open PR, human
   *  gate, settled blocker): the gate verdict. */
  onGate(ctx: C, item: I): V | Promise<V>;
  /** onPark — the item must park: the settle verdict (the note, wake
   *  predicate, and claim release are the policy's own IO inside its
   *  verdict path). `why` names the park cause. */
  onPark(ctx: C, item: I, why: string): V | Promise<V>;
  /** onLost — the item's worker or claim is lost: re-queue, park, or
   *  a terminal verdict — auditable, never a silent retry. */
  onLost(ctx: C, item: I): V | Promise<V>;
}
