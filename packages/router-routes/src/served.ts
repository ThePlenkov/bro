/**
 * The served universe — what the router may land a request on.
 *
 * A route names the models a request lands on. The operator declares
 * what a provider serves in `brouter.models` — a canonical id and the
 * routes that serve it. A route naming a model that declaration
 * CONTRADICTS is a config error, never a skipped entry: `devin-acp`
 * serves the swe-2 family, and a route that lands on
 * `devin-acp/claude-opus-5` is wrong, not merely unusual.
 *
 * A declaration SILENT about a provider is not a verdict: absent = off.
 * The rule only bites where the operator has already spoken — the
 * registry is the router's own truth, and the router's catalog (the
 * runtime one) still owns what an acp lane advertises.
 */
import type { RouteTable } from './types.ts';

/** The declaration — a canonical id and the routes that serve it. */
export interface ServedDeclaration {
  [modelId: string]: { provider: string; model?: string }[];
}

/** One chain entry the declaration contradicts. */
export interface UnservedChain {
  /** the route that names it */
  route: string;
  /** the chain entry's provider */
  provider: string;
  /** the chain entry's model */
  model: string;
  /** why the entry is unserved */
  reason: string;
}

/** The models the declaration gives each provider. */
function declaredByProvider(declared: ServedDeclaration): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const [modelId, routes] of Object.entries(declared)) {
    for (const route of routes) {
      const models = byProvider.get(route.provider) ?? new Set<string>();
      models.add(route.model ?? modelId);
      byProvider.set(route.provider, models);
    }
  }
  return byProvider;
}

/** The chain entries the declaration contradicts. */
export function unservedChains(table: RouteTable, declared: ServedDeclaration): UnservedChain[] {
  const byProvider = declaredByProvider(declared);
  const out: UnservedChain[] = [];
  for (const route of table.routes) {
    for (const entry of route.chain) {
      const models = byProvider.get(entry.provider);
      // the declaration says nothing about this provider — no verdict
      if (models === undefined) {
        continue;
      }
      // a bare provider names the provider's own model — nothing to contradict
      if (entry.model === undefined) {
        continue;
      }
      if (models.has(entry.model)) {
        continue;
      }
      out.push({
        route: route.name,
        provider: entry.provider,
        model: entry.model,
        reason:
          `brouter.models declares ${entry.provider} for ` +
          `${[...models].sort((a, b) => a.localeCompare(b)).join(', ')} — not ${entry.model}`,
      });
    }
  }
  return out;
}
