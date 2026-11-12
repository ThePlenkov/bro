/**
 * brouter — the model-centric provider routing registry (spec:
 * specs/bro-n1p0s.md). Model ids are the routing key: a consumer asks
 * for a MODEL and the registry answers which `providers.<name>` serves
 * it — the inverse of today's provider-first selection
 * (`agents.<backend>.provider`, `fleet.routing` chains).
 *
 * Three sources, first hit wins: qualified `provider/model` ids (head
 * must be a configured provider), `brouter.models` declarations, and
 * the catalog index (who advertises the id — caller-supplied, since
 * live enumeration is a CLI-side probe the spawn path never pays).
 *
 * Core holds types + the pure resolver — no IO. Live catalog
 * enumeration (cli `models` templates, acp `configOptions`) stays in
 * the CLI layer; `brouterStaticCatalog` is the offline face.
 */
import type { ProviderEntry } from './providers.ts';
import type { FleetRouter } from './routing.ts';

/** One declared route — the provider pick plus the upstream model id
 *  it serves. `model` absent = the registry key verbatim (the bare
 *  provider-name shorthand). */
export interface BrouterRoute {
  provider: string;
  model?: string;
}

/** `brouter.models` normalized — every entry an ordered candidate
 *  list; list order is preference order, [0] the primary pick. */
export type BrouterModels = Record<string, BrouterRoute[]>;

/** How often the judge is ASKED (spec bro-0ykhg.2) — `mode` says whether
 *  a T2/T3 answer is trusted; `invoke` says whether it is asked at all:
 *  `always` asks on every task (today's behavior), `ambiguous` (the
 *  default) asks only when the surviving candidates need it, `never`
 *  keeps the cascade to T0 rules + T1 recall. */
export type RouterInvoke = 'always' | 'ambiguous' | 'never';

/** T1 outcome-recall tuning — how many similar verified outcomes vote,
 *  and how strongly they must agree before recall decides a route. */
export interface RouterRecall {
  /** how many top-scoring similar outcome rows vote (default 5) */
  k?: number;
  /** the fraction of voting rows that must name the winner (default 0.6) */
  minAgreement?: number;
  /** the minimum number of rows that must vote before recall may
   *  decide (default 3) */
  minRows?: number;
}

/** The brouter decision model — the fleet router's provider+mode plus
 *  the cascade's invoke/escalate/recall knobs (bro-0ykhg.2). */
export interface BrouterRouter extends FleetRouter {
  invoke?: RouterInvoke;
  /** the T3 provider — a second judge asked only when T2's answer sits
   *  in lowConfidence; absent = table order stands */
  escalate?: string;
  /** T1 outcome-recall tuning — absent fields take the defaults */
  recall?: RouterRecall;
}

/** The `brouter` config section — the model's registry plus the path of
 *  the route table that maps a task to a (provider, model) chain. */
export interface BrouterConfig {
  models: BrouterModels;
  /** the route table's path — the TOML file the routes live in */
  routes?: string;
  /** the routing formula's path — the md file whose frontmatter is the
   *  machine contract (typed questions, hard filters, score weights)
   *  and whose body is the prose the decision model reads */
  formula?: string;
  /** the decision model — the judge that picks the route, plus the
   *  cascade's invoke/escalate/recall knobs (bro-0ykhg.2) */
  router?: BrouterRouter;
  /** the outcome namespace for standalone callers — the canonical repo
   *  id wins when the dir sits in a git project; this names the
   *  namespace when it does not (spec bro-0ykhg.4) */
  contextId?: string;
  /** days a decision's task text persists for recall/replay — default
   *  30; 0 disables text persistence entirely */
  taskTextRetentionDays?: number;
}

/** Where a declared route sits — the model id it was declared under
 *  plus the route index when the key declares several. A domain
 *  object rather than a pre-formatted label: the parse layer owns
 *  the label format, so the index never leaks into a message built
 *  at the wrong depth. */
interface RouteAt {
  readonly key: string;
  readonly index?: number;
}

/** One registry entry's parsed routes — the trimmed key plus the
 *  route list it declares. */
interface ModelEntry {
  readonly key: string;
  readonly routes: BrouterRoute[];
}

/** A declared route named a provider no entry resolves to — a config
 *  error naming the brouter key, never a skipped entry. */
export class BrouterConfigError extends Error {
  constructor(key: string, providerName: string) {
    super(
      `brouter.models.${key} — providers.${providerName} is not configured — ` +
        'name a configured provider entry'
    );
    this.name = 'BrouterConfigError';
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A section's own bag — anything that is not a table is an empty bag. */
const rawBag = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {});

/** The label a parse warning names — `x`, or `x[2]` for the third
 *  route under key `x`. */
function atLabel(at: RouteAt): string {
  return at.index === undefined ? at.key : `${at.key}[${at.index}]`;
}

/** The optional model — a present-but-bad model drops the field, not the
 *  route. */
function routeModel(at: RouteAt, v: Record<string, unknown>): string | undefined {
  if (v.model === undefined) {
    return undefined;
  }
  const model = str(v.model);
  if (model === undefined) {
    console.error(
      `bro.config: brouter.models.${atLabel(at)}.model must be a non-empty string — field dropped`
    );
  }
  return model;
}

/** The `{provider, model?}` route form — `provider` is required, a
 *  present-but-bad `model` drops the field, not the route. */
function routeObject(at: RouteAt, v: Record<string, unknown>): BrouterRoute | null {
  const provider = str(v.provider);
  if (provider === undefined) {
    console.error(`bro.config: brouter.models.${atLabel(at)} requires "provider" — route dropped`);
    return null;
  }
  const model = routeModel(at, v);
  return model === undefined ? { provider } : { provider, model };
}

/** One route value — `"<provider>"` or `{provider, model?}`. Bad
 *  entries drop with a warning; a key whose routes all dropped falls
 *  out of the registry (providers.ts' field-vs-entry convention). */
function routeEntry(at: RouteAt, v: unknown): BrouterRoute | null {
  if (typeof v === 'string' && v.trim() !== '') {
    return { provider: v.trim() };
  }
  if (isPlainObject(v)) {
    return routeObject(at, v);
  }
  console.error(
    `bro.config: brouter.models.${atLabel(at)} must be a provider name or {provider, model} — route dropped`
  );
  return null;
}

/** One registry key's route list — `v` is a route value or an ordered
 *  array of them; a key whose routes all dropped leaves the registry. */
function routeList(at: RouteAt, v: unknown): BrouterRoute[] | null {
  const entries = Array.isArray(v) ? v : [v];
  const routes = entries
    .map((e, i) => routeEntry(Array.isArray(v) ? { key: at.key, index: i } : at, e))
    .filter((r): r is BrouterRoute => r !== null);
  if (routes.length === 0) {
    console.error(`bro.config: brouter.models.${atLabel(at)} has no usable routes — entry dropped`);
    return null;
  }
  return routes;
}

/** The section's `models` bag after shape checks — a malformed
 *  `brouter` or `brouter.models` warns and yields undefined (sections
 *  parse independently; the absent registry is 'off', not an error). */
function modelsBag(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    return droppedBag(raw);
  }
  if (raw.models === undefined) {
    return {};
  }
  if (!isPlainObject(raw.models)) {
    console.error('bro.config: brouter.models must be an object — field dropped');
    return {};
  }
  return raw.models;
}

/** The whole section is not a table — the bag is empty, and a section
 *  that WAS declared says so. */
function droppedBag(raw: unknown): Record<string, unknown> {
  if (raw !== undefined) {
    console.error('bro.config: brouter must be an object — section dropped');
  }
  return {};
}

/** One registry entry's routes — null when the entry drops: an empty
 *  key, a route list with nothing usable in it, or a key that
 *  collides with an earlier one after trimming (the first wins, the
 *  later entry is dropped with a warning). */
function modelEntry(models: BrouterModels, id: string, v: unknown): ModelEntry | null {
  const key = id.trim();
  if (key === '') {
    console.error('bro.config: brouter.models keys must be non-empty model ids — entry dropped');
    return null;
  }
  const routes = routeList({ key }, v);
  if (routes === null) {
    return null;
  }
  if (Object.hasOwn(models, key)) {
    console.error(
      `bro.config: brouter.models.${key} duplicates another key after trimming — later entry dropped`
    );
    return null;
  }
  return { key, routes };
}

/** `brouter` section parse — shape only; route providers resolve
 *  against `providers` at use (sections parse independently — an
 *  unknown name is a use-time config error naming the model key, same
 *  rule as `fleet.routing` chain entries). */
export function parseBrouter(raw: unknown): BrouterConfig {
  const models: BrouterModels = {};
  const bag = rawBag(raw);
  for (const [id, v] of Object.entries(modelsBag(raw))) {
    const entry = modelEntry(models, id, v);
    if (entry === null) {
      continue;
    }
    // defineProperty, not assignment — a model id like '__proto__'
    // must land as an own key, never trigger the prototype setter
    // (same guard as providers' model ids)
    Object.defineProperty(models, entry.key, {
      value: entry.routes,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const routes = routeTablePath(bag);
  const formula = formulaPath(bag);
  const router = decisionModel(bag.router);
  const contextId = str(bag.contextId);
  const retention = bag.taskTextRetentionDays;
  return {
    models,
    ...(routes === undefined ? {} : { routes }),
    ...(formula === undefined ? {} : { formula }),
    ...(router === undefined ? {} : { router }),
    ...(contextId === undefined ? {} : { contextId }),
    ...(typeof retention === 'number' && Number.isFinite(retention) && retention >= 0
      ? { taskTextRetentionDays: Math.floor(retention) }
      : {}),
  };
}

/** The decision modes the table accepts. */
const ROUTER_MODES = new Set(['shadow', 'enforce', 'off']);

/** The invoke modes the cascade accepts (bro-0ykhg.2). */
const ROUTER_INVOKES = new Set(['always', 'ambiguous', 'never']);

/** The mode — one of the three the table accepts. */
function isRouterMode(mode: unknown): mode is FleetRouter['mode'] {
  return typeof mode === 'string' && ROUTER_MODES.has(mode);
}

/** A positive integer tuning count — k and minRows count rows, so a
 *  fraction is meaningless. */
function tuningCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;
}

/** The agreement bar — a fraction in (0, 1]. */
function tuningFraction(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
}

/** The T1 recall tuning — {k, minAgreement, minRows}, each optional.
 *  Each field holds the same bounds the emitted JSON schema declares —
 *  counts are integers >= 1, the agreement bar is (0, 1] — so a value
 *  the schema would reject drops loudly here instead of being floored
 *  or clamped silently at the call site (bro-0ykhg.2 review). */
function recallTuning(raw: unknown): RouterRecall | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('bro.config: brouter.router.recall must be an object — field dropped');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: RouterRecall = {};
  const k = tuningCount(o.k);
  const minAgreement = tuningFraction(o.minAgreement);
  const minRows = tuningCount(o.minRows);
  if (o.k !== undefined && k === undefined) {
    console.error('bro.config: brouter.router.recall.k must be an integer >= 1 — field dropped');
  }
  if (k !== undefined) out.k = k;
  if (o.minAgreement !== undefined && minAgreement === undefined) {
    console.error(
      'bro.config: brouter.router.recall.minAgreement must be a number in (0, 1] — field dropped'
    );
  }
  if (minAgreement !== undefined) out.minAgreement = minAgreement;
  if (o.minRows !== undefined && minRows === undefined) {
    console.error(
      'bro.config: brouter.router.recall.minRows must be an integer >= 1 — field dropped'
    );
  }
  if (minRows !== undefined) out.minRows = minRows;
  return out;
}

/** The decision model — the judge provider and the mode, plus the
 *  cascade's invoke/escalate/recall knobs (bro-0ykhg.2). Absent means
 *  the table's own order decides; 'shadow' journals the model's opinion
 *  and picks nothing; 'enforce' lets a confident pick win; `invoke`
 *  says how often the judge is ASKED at all. */
function decisionModel(raw: unknown): BrouterRouter | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const o = rawBag(raw);
  const provider = str(o.provider) ?? '';
  const mode = o.mode;
  if (provider === '' || !isRouterMode(mode)) {
    console.error(
      'bro.config: brouter.router requires provider + mode (shadow|enforce|off) — section dropped'
    );
    return undefined;
  }
  const out: BrouterRouter = { provider, mode };
  const invoke = o.invoke;
  if (invoke !== undefined) {
    if (typeof invoke === 'string' && ROUTER_INVOKES.has(invoke)) {
      out.invoke = invoke as RouterInvoke;
    } else {
      console.error(
        'bro.config: brouter.router.invoke must be always|ambiguous|never — field dropped'
      );
    }
  }
  const escalate = str(o.escalate);
  if (escalate !== undefined) {
    out.escalate = escalate;
  }
  const recall = recallTuning(o.recall);
  if (recall !== undefined) {
    out.recall = recall;
  }
  return out;
}

/** The route table's path — a non-empty string, or nothing. */
function routeTablePath(raw: unknown): string | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const value = raw.routes;
  if (value === undefined) {
    return undefined;
  }
  const path = str(value);
  if (path === undefined) {
    console.error('bro.config: brouter.routes must be a path — field dropped');
  }
  return path;
}

/** The routing formula's path — the same contract as the table's. */
function formulaPath(raw: unknown): string | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const value = raw.formula;
  if (value === undefined) {
    return undefined;
  }
  const path = str(value);
  if (path === undefined) {
    console.error('bro.config: brouter.formula must be a path — field dropped');
  }
  return path;
}

/** The registry's offline catalog — every model id statically known
 *  to be served: the api kind's allowlist keys, plus each entry's
 *  pinned `model`. Live surfaces (cli `models` template, acp session
 *  options) are a CLI-side probe — the spawn path resolves on this
 *  index so a spawn never pays a catalog call. */
export function brouterStaticCatalog(
  providers: Record<string, ProviderEntry>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(providers)) {
    const ids = entry.type === 'api' ? Object.keys(entry.models) : [];
    if (entry.model !== undefined && !ids.includes(entry.model)) {
      ids.push(entry.model);
    }
    out[name] = ids;
  }
  return out;
}

/** A resolved route — the provider pick and the upstream model id it
 *  serves (the asked id verbatim unless the route rewrote it).
 *  Provenance records THIS model, never the alias. */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** The source-1 test — `asked` is `<provider>/<model>` with a
 *  configured provider head and a non-empty model tail. Callers that
 *  short-circuit static sources use this to know a qualified hit is
 *  guaranteed without resolving. */
export function isQualifiedRouteId(
  providers: Record<string, ProviderEntry>,
  asked: string
): boolean {
  const slash = asked.indexOf('/');
  return slash > 0 && slash < asked.length - 1 && Object.hasOwn(providers, asked.slice(0, slash));
}

/** Source-2 expansion — the declared candidate list for `asked`, each
 *  provider validated at use; an unconfigured name throws naming the
 *  brouter key (suffixed [i] when the entry declares several). */
function declaredRoutes(
  providers: Record<string, ProviderEntry>,
  routes: BrouterRoute[],
  asked: string
): ModelRoute[] {
  return routes.map((r, i) => {
    if (!Object.hasOwn(providers, r.provider)) {
      const at = routes.length > 1 ? `${asked}[${i}]` : asked;
      throw new BrouterConfigError(at, r.provider);
    }
    return { provider: r.provider, model: r.model ?? asked };
  });
}

/** Model → ordered route candidates. Sources, first hit wins:
 *
 *  1. qualified `<provider>/<model>` — head is a configured provider;
 *     the route is verbatim (provider-side validation judges
 *     servability downstream). A head that isn't configured is not a
 *     qualifier — vendor-namespaced ids (`opencode/x`, `kilo/orca/…`)
 *     fall through to the bare-id sources.
 *  2. `brouter.models.<id>` — its ordered order; a route naming an
 *     unconfigured provider throws BrouterConfigError naming the key.
 *  3. the catalog — providers serving the id exactly, in `providers`
 *     insertion order.
 *
 *  Empty = unresolved — the caller owns the verdict (a read surface
 *  reports it, a spawn path falls back to label provenance). */
export function resolveModelRoute(
  providers: Record<string, ProviderEntry>,
  brouter: BrouterConfig | undefined,
  catalog: Record<string, string[]>,
  asked: string
): ModelRoute[] {
  const slash = asked.indexOf('/');
  if (isQualifiedRouteId(providers, asked)) {
    return [{ provider: asked.slice(0, slash), model: asked.slice(slash + 1) }];
  }
  if (brouter !== undefined && Object.hasOwn(brouter.models, asked)) {
    return declaredRoutes(providers, brouter.models[asked]!, asked);
  }
  return Object.keys(providers)
    .filter(name => (catalog[name] ?? []).includes(asked))
    .map(provider => ({ provider, model: asked }));
}
