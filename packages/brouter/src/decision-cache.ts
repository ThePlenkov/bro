/**
 * The decision cache (spec bro-0ykhg.3) — an opt-in memo of the T2
 * stage answers, keyed by formula version and task shape.
 *
 * `brouter.router.cache = off | exact | recall` — `off` is the default
 * and writes nothing. The cache is a MODE of the router, never a
 * requirement: every lookup, write and invalidation is best-effort —
 * an unavailable store costs the memo, never the decision.
 *
 * The key is canonical JSON (never string concatenation) of
 * `{contextId, formulaHash, tableHash, shape, judgeConfigHash}` plus
 * the task's identity — the normalized full text and carried T0
 * fields under `exact` (hashed, never verbatim, when
 * `taskTextRetentionDays: 0` — key_json is stored data), the scoped
 * T1 recall cluster under `recall`.
 * `judgeConfigHash` covers the effective judge provider, model,
 * parameters and escalation configuration — never credential material
 * (the runtime `apiKey` a proxied entry carries is stripped, and env
 * var NAMES are references, not secrets). Keys are computable before
 * T2: inferred answers belong only in the VALUE, never the lookup.
 *
 * The value is the stage answers — the DecideResult (or the pick
 * name), never the route. On a hit the code re-runs the candidates,
 * the filters, the health and the chain, so a wall that appeared
 * since the write is honored exactly as on a fresh ask.
 *
 * Invalidations live in router-store: formula/table hash changes miss
 * by construction, the TTL expires entries, and a verified outcome
 * that fails the formula's success predicate drops the source entry —
 * transactionally, under a persistent per-key generation a late write
 * cannot resurrect.
 */
import type { BrouterRouter, DecideResult, FleetRouter, ProviderEntry } from '@broject/core';
import type { RouteCacheInfo, RouteTable, RouteTask } from '@broject/router-routes';
import {
  cacheGeneration,
  canonicalJson,
  contentHash,
  migrateStore,
  openStore,
  readCacheEntry,
  routerStorePath,
  textHash,
  writeCacheEntry,
  type StoreFace,
} from '@broject/router-store';
import { decisionContextId, taskTextRetentionDays } from './context.ts';
import { decisionProvider } from './decision-model.ts';

/** The cache modes a decision can run — 'off' never reaches this file. */
export type ActiveCacheMode = 'exact' | 'recall';

/** The resolved cache configuration — mode plus the entry TTL. */
export interface CacheConfig {
  mode: ActiveCacheMode;
  ttlMs: number;
}

/** The default entry lifetime — `cacheTtlHours` unset means 24h. */
export const DEFAULT_CACHE_TTL_HOURS = 24;

/** Resolve the effective cache config — `--no-cache` wins over the
 *  config, 'off' (the default) resolves to undefined: no key, no
 *  lookup, no write, no journal field. */
export function cacheConfig(
  router: BrouterRouter | undefined,
  noCache: boolean | undefined
): CacheConfig | undefined {
  if (noCache === true) {
    return undefined;
  }
  const mode = router?.cache ?? 'off';
  if (mode === 'off') {
    return undefined;
  }
  const hours = router?.cacheTtlHours;
  const ttlHours =
    typeof hours === 'number' && Number.isFinite(hours) && hours > 0
      ? hours
      : DEFAULT_CACHE_TTL_HOURS;
  return { mode, ttlMs: ttlHours * 3_600_000 };
}

/** The task text, normalized — trimmed, internal whitespace collapsed.
 *  Case is preserved: 'Fix' and 'fix' are different asks until proven
 *  otherwise (a miss is always safe, a wrong hit is not). */
export function normalizeTaskText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** The carried T0 fields/features, normalized — scalar fields verbatim,
 *  labels and paths sorted (they are sets: order carries no meaning),
 *  features left for canonicalJson's own key ordering. Only DEFINED
 *  fields land — an absent field and an empty one are different asks. */
export function normalizeTask(task: RouteTask): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (task.type !== undefined) out.type = task.type;
  if (task.complexity !== undefined) out.complexity = task.complexity;
  if (task.priority !== undefined) out.priority = task.priority;
  if (task.repo !== undefined) out.repo = task.repo;
  if (task.labels !== undefined) out.labels = [...task.labels].sort();
  if (task.paths !== undefined) out.paths = [...task.paths].sort();
  if (task.features !== undefined) out.features = task.features;
  return out;
}

/** The provider entry's answer-shaping projection — a WHITELIST per
 *  kind: the fields that decide what the judge is asked and how the
 *  reply is read. `apiKey` is runtime credential material and never
 *  enters a hash (a proxied served entry embeds the router's token —
 *  it rotates per boot and must not churn the key); `mcpServers` can
 *  carry secrets and `rateGate` is spawn admission, not answer shape. */
function sanitizedEntry(entry: ProviderEntry): Record<string, unknown> {
  switch (entry.type) {
    case 'api':
      return {
        type: 'api',
        account: entry.account,
        baseUrl: entry.baseUrl,
        models: entry.models,
        model: entry.model,
        apiKeyEnv: entry.apiKeyEnv,
        apiKeyCommand: entry.apiKeyCommand,
      };
    case 'acp':
      return {
        type: 'acp',
        account: entry.account,
        command: entry.command,
        profile: entry.profile,
        model: entry.model,
        apiKeyEnv: entry.apiKeyEnv,
        sessionRm: entry.sessionRm,
        autoApprove: entry.autoApprove,
        wallPause: entry.wallPause,
      };
    case 'cli':
      return {
        type: 'cli',
        account: entry.account,
        command: entry.command,
        model: entry.model,
        models: entry.models,
        wallPause: entry.wallPause,
      };
  }
}

/** The escalate provider's projection — same whitelist, 'unresolved'
 *  when the provider cannot be bound (a misconfigured T3 changes the
 *  hash the day it is fixed, which is exactly when answers may differ). */
function escalateProjection(
  dir: string,
  router: FleetRouter,
  escalate: string
): Record<string, unknown> {
  try {
    const provider = decisionProvider(dir, { provider: escalate, mode: router.mode });
    return {
      name: provider.name,
      kind: provider.kind,
      entry: sanitizedEntry(provider.entry),
    };
  } catch {
    return { name: escalate, unresolved: true };
  }
}

/** The judge configuration identity — provider resolution (lane vs
 *  served), the sanitized entry, the router's own mode, the T3
 *  escalation configuration, and the judge parameters that reach the
 *  decision facade (the confidence bar and the whole-call deadline).
 *  Undefined when the provider cannot be resolved — the caller then
 *  skips the cache entirely rather than key on a guess. */
export async function judgeConfigHash(
  dir: string,
  router: FleetRouter | undefined,
  escalate?: string
): Promise<string | undefined> {
  if (router === undefined) {
    return undefined;
  }
  try {
    const { judgeConfig } = await import('@broject/judge');
    const jcfg = judgeConfig(dir).judge;
    const provider = decisionProvider(dir, router);
    return contentHash({
      provider: provider.name,
      kind: provider.kind,
      mode: router.mode,
      entry: sanitizedEntry(provider.entry),
      escalate: escalate === undefined ? null : escalateProjection(dir, router, escalate),
      judge: { confidence: jcfg.confidence, timeoutMs: jcfg.timeoutMs },
    });
  } catch {
    return undefined;
  }
}

/** The cache key's inputs — everything the decision path already
 *  knows before T2 runs. */
export interface CacheKeyInput {
  dir: string;
  tablePath?: string;
  table: RouteTable;
  /** the task text the judge reads */
  text: string;
  /** the carried T0 fields/features */
  task: RouteTask;
  /** the decision model — provider + mode (+ escalate via `escalate`) */
  router?: FleetRouter;
  /** the T3 provider name — part of the judge configuration identity */
  escalate?: string;
  /** the formula file's raw bytes — NULL hash when formula-less */
  formulaText?: string;
  /** the formula shape — 'none' on the formula-less path */
  shape: 'none' | 'features' | 'pick' | 'score';
  mode: ActiveCacheMode;
  /** the scoped T1 recall cluster — required under 'recall', ignored
   *  under 'exact' */
  cluster?: string;
}

/** The built key — canonical JSON for storage, its sha256 for lookup,
 *  and the context the entry journals under. Undefined when no key can
 *  be built: an unresolvable judge configuration, or a 'recall' mode
 *  with no eligible cluster (a normal miss, never an error). */
export async function buildCacheKey(
  input: CacheKeyInput
): Promise<{ keyJson: string; keyHash: string; contextId: string } | undefined> {
  if (input.mode === 'recall' && input.cluster === undefined) {
    return undefined;
  }
  const judge = await judgeConfigHash(input.dir, input.router, input.escalate);
  if (judge === undefined) {
    return undefined;
  }
  const contextId = decisionContextId(input.dir, {
    ...(input.tablePath === undefined ? {} : { tablePath: input.tablePath }),
  });
  const key = {
    v: 1,
    contextId,
    formulaHash: input.formulaText === undefined ? null : textHash(input.formulaText),
    tableHash: contentHash(input.table),
    shape: input.shape,
    judge,
    mode: input.mode,
    task: exactTask(input),
  };
  return { keyJson: canonicalJson(key), keyHash: contentHash(key), contextId };
}

/** The task slot of the key — under 'recall' the scoped cluster (a
 *  hash already), under 'exact' the normalized text plus the carried
 *  fields. `key_json` is STORED, so it honors the same retention
 *  contract the decision ledger keeps (context.ts): with
 *  `taskTextRetentionDays: 0` the text lands as its sha256 — hashes
 *  and structured inputs persist, free text never does. The fields
 *  ride along unchanged: the ledger keeps taskJson/featuresJson under
 *  retention 0 too. A retention flip changes the key by construction —
 *  old text-bearing rows miss and expire rather than serve. */
function exactTask(input: CacheKeyInput): Record<string, unknown> {
  if (input.mode === 'recall') {
    return { cluster: input.cluster };
  }
  const text = normalizeTaskText(input.text);
  const fields = normalizeTask(input.task);
  return taskTextRetentionDays(input.dir) === 0
    ? { textHash: textHash(text), fields }
    : { text, fields };
}

/** What a lookup answers — the generation the write must match, plus
 *  the entry when one is live. */
export interface CacheConsult {
  /** the key's generation NOW — captured before T2 runs */
  generation: number;
  hit?: {
    /** the stored stage answers as JSON */
    valueJson: string;
    /** how old the entry was at lookup, ms */
    ageMs: number;
  };
}

/** One store open for a cache read — migrate, read, close. Undefined
 *  on any failure: the cache is a memo, never a gate. The ledger is
 *  the XDG-global router.db — the key's contextId already namespaces
 *  the project, so no dir threads through. */
async function withCacheStore<T>(fn: (store: StoreFace) => T | Promise<T>): Promise<T | undefined> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return undefined;
  }
  try {
    migrateStore(handle.db);
    return await fn(handle);
  } catch (err) {
    console.error(
      `warning: brouter decision cache — ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  } finally {
    handle.close();
  }
}

/** Consult the cache for a built key — the generation is ALWAYS
 *  returned (it is what the post-T2 write compares against); `hit`
 *  carries the live entry's value and age. An entry whose generation
 *  trails the counter is treated as absent — the invariant the write
 *  transaction maintains, re-checked here defensively. */
export async function consultCache(
  keyHash: string,
  now: number = Date.now()
): Promise<CacheConsult | undefined> {
  return withCacheStore(store => {
    const generation = cacheGeneration(store.db, keyHash);
    const entry = readCacheEntry(store.db, keyHash, now);
    return {
      generation,
      ...(entry !== undefined && entry.generation === generation
        ? { hit: { valueJson: entry.valueJson, ageMs: now - entry.createdAt } }
        : {}),
    };
  });
}

/** What a consult hands the decision path — the built key (the write's
 *  target and the journal's provenance), the generation captured
 *  BEFORE T2 ran (the write's compare-and-set expectation), and the
 *  decoded stage answers when a live entry answered. */
export interface CachePlan {
  key: { keyJson: string; keyHash: string; contextId: string };
  consult: CacheConsult;
  /** the live entry's decoded value + age — present on a hit only */
  hit?: { value: CacheValue; ageMs: number };
}

/** Build the key, then consult — one call the decision paths share.
 *  Undefined when no consult can happen: no key (unresolvable judge
 *  config, or 'recall' with no eligible cluster) or an unreadable
 *  store. A live entry whose value does not decode reads as a miss —
 *  the next write overwrites it. */
export async function planCacheConsult(input: CacheKeyInput): Promise<CachePlan | undefined> {
  const key = await buildCacheKey(input);
  if (key === undefined) {
    return undefined;
  }
  const consult = await consultCache(key.keyHash);
  if (consult === undefined) {
    return undefined;
  }
  const value = consult.hit === undefined ? undefined : decodeCacheValue(consult.hit.valueJson);
  return {
    key,
    consult,
    ...(consult.hit !== undefined && value !== undefined
      ? { hit: { value, ageMs: consult.hit.ageMs } }
      : {}),
  };
}

/** The provenance the decision carries — hit or consulted-and-missed.
 *  Undefined when the cache never ran (off, or no consult possible). */
export function cacheInfo(plan: CachePlan | undefined, hit: boolean): RouteCacheInfo | undefined {
  if (plan === undefined) {
    return undefined;
  }
  return {
    hit,
    key: plan.key.keyHash,
    generation: plan.consult.generation,
    ...(hit && plan.hit !== undefined ? { ageMs: plan.hit.ageMs } : {}),
  };
}

/** The stage answers a cache entry stores — the judge's DecideResult
 *  (questions shapes) or the pick name (pick shapes and the
 *  formula-less path). Never the route: resolution re-runs on a hit. */
export type CacheValue =
  | { kind: 'pick'; pick: string | null }
  | { kind: 'answers'; res: DecideResult; t3: boolean };

/** The value's stored form — canonical JSON, like every ledger blob. */
export function encodeCacheValue(value: CacheValue): string {
  return canonicalJson(value);
}

/** Decode a stored value — undefined on malformed JSON or an
 *  unrecognized shape (a corrupt entry reads as a miss, and the next
 *  write overwrites it). */
export function decodeCacheValue(json: string): CacheValue | undefined {
  try {
    const value = JSON.parse(json) as CacheValue;
    if (value?.kind === 'pick' && (value.pick === null || typeof value.pick === 'string')) {
      return value;
    }
    if (
      value?.kind === 'answers' &&
      typeof value.res === 'object' &&
      value.res !== null &&
      // typeof null === 'object' — a corrupt entry must not decode into
      // a hit that crashes the replay on Object.keys(null)
      typeof value.res.answers === 'object' &&
      value.res.answers !== null &&
      !Array.isArray(value.res.answers) &&
      typeof value.t3 === 'boolean'
    ) {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The entry's age, human — '45s', '3h', '2d' — for stage notes and
 *  the explanation's cache fact. */
export function formatCacheAge(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h`;
  }
  return `${Math.floor(h / 24)}d`;
}

/** Store the stage answers under the consulted key — the write's
 *  compare-and-set runs inside router-store's transaction: it lands
 *  only while the generation captured before T2 is unchanged. Returns
 *  whether the entry landed (false on a stale generation or a store
 *  failure — the decision stands either way). */
export async function storeCacheValue(
  key: { keyHash: string; keyJson: string; contextId: string },
  consult: { generation: number },
  value: CacheValue,
  ttlMs: number
): Promise<boolean> {
  const written = await withCacheStore(store =>
    writeCacheEntry(store, {
      keyHash: key.keyHash,
      keyJson: key.keyJson,
      contextId: key.contextId,
      valueJson: encodeCacheValue(value),
      generation: consult.generation,
      ttlMs,
    })
  );
  return written ?? false;
}
