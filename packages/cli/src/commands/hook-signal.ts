/** stderr marker for a hook dispatch failure — `bro hooks` exits 0 on a
 *  dispatch throw by contract (fail-open: a bro bug must never break the
 *  session), so the exit code can't carry the failure. Watchdogs that
 *  spawn hooks — the latency bench (scripts/bench-hooks.ts) — detect the
 *  throw by matching this line instead. */
export const HOOK_DISPATCH_ERR = 'bro-hooks: dispatch failed';
