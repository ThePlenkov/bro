/** External activity planes — the spawn guard's view of agents bro does
 *  not own (spec bro-eqi2d).
 *
 *  A plane is one agent ecosystem's answer to "is an agent session this
 *  rig did NOT spawn actively working on this host?" — interactive
 *  devin/opencode sessions, foreign headless workers, remote copilot
 *  tasks, host sessions that armed work markers. Core owns only the
 *  registry and the report shape; vendor knowledge registers itself
 *  beside its session plane.
 *
 *  The two judgements every probe makes:
 *
 *  - **Ownership** — a live session is bro's own when its environ
 *    carries `BRO_AGENT_ID` (every backend pins it) or `BRO_HOOKS=0`
 *    (the acp provider pins pooled peer children). Anything else live is
 *    external. An UNREADABLE environ cannot prove ownership — the
 *    session counts as external (fail closed, the same convention the
 *    quota lanes hold).
 *  - **Idleness** — "active" needs a proven stamp inside `holdMs`. A
 *    live session whose stamps are all older has gone idle; a live
 *    session with no readable stamp cannot prove idle and counts
 *    active. */

/** One plane's verdict. `active` is the gate's question; `detail` names
 *  the session so a refusal says WHO is working; `activityAtMs` is the
 *  freshest stamp the probe could prove — observability, never the
 *  gate's input (a plane already folded it into `active`). */
export interface ExternalActivity {
  active: boolean;
  detail?: string;
  activityAtMs?: number;
}

/** What a probe reads. `dir` is the repo root — the marker plane's scope
 *  and the registry the copilot plane correlates against. `agents` is
 *  the whole `agents` config map — a plane's overrides ride
 *  `agents.<kind>` exactly like the quota planes read their bag.
 *  `workerEnv` is the env the spawn would run under: a worker handed a
 *  different XDG base writes its session marks there, so the scan must
 *  cover it (the quota planes' convention). `env` is the spawner's own
 *  environment for XDG/HOME derivation. */
export interface ExternalProbeCtx {
  dir: string;
  agents: Record<string, Record<string, unknown>>;
  workerEnv?: Record<string, string>;
  env: Record<string, string | undefined>;
  /** The idle window — activity older than `now - holdMs` releases. */
  holdMs: number;
  now: number;
}

/** An external-activity plane. The probe must be synchronous — the gate
 *  runs inside the spawn critical section. Throwing SpawnError is how a
 *  plane reports an unverifiable scan; the gate lets it surface as the
 *  refusal (fail closed). */
export interface ExternalActivityPlane {
  readonly kind: string;
  externalActivity(ctx: ExternalProbeCtx): ExternalActivity;
}

const planes = new Map<string, ExternalActivityPlane>();

/** Register a plane — builtins register at import; re-registering a
 *  kind replaces it (tests reset via clearExternalPlanes). */
export function registerExternalPlane(plane: ExternalActivityPlane): void {
  planes.set(plane.kind, plane);
}

/** The registered planes, in registration order. */
export function externalPlanes(): ExternalActivityPlane[] {
  return [...planes.values()];
}

/** Test hook — drop all registrations. */
export function clearExternalPlanes(): void {
  planes.clear();
}

/** The NUL-anchored ownership badge — `BRO_AGENT_ID` pins every spawned
 *  worker; `BRO_HOOKS=0` pins the acp provider's pooled session children
 *  (serve/conductor's `devin acp`, judge turns). Anchored like
 *  proc-owner's AGENT_ENV_RE: an unanchored match would take
 *  `XBRO_AGENT_ID=` or `BRO_HOOKS=1`. */
const OWNED_ENV_RE = /(?:^|\0)(?:BRO_AGENT_ID=[^\0]+|BRO_HOOKS=0(?:\0|$))/;

/** Is this environ bro-owned? A caller reads /proc/<pid>/environ once
 *  and applies the shared predicate so every plane classifies the same
 *  way. An empty/unreadable environ proves nothing — the caller decides
 *  the fail-closed verdict (external). */
export function ownedEnviron(environ: string): boolean {
  return OWNED_ENV_RE.test(environ);
}
