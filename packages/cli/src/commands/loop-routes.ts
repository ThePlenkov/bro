/**
 * The route table in the spawn path — the route a bead lands on.
 *
 * The fleet's `fleet.routing` answers "which lane does this class take";
 * the route table answers the same question with the router's own
 * vocabulary — a template file, the health of every model, and a chain
 * the operator wrote. When the table is declared it IS the routing face
 * (the fleet's section stays the compatibility face); when it is not,
 * nothing here runs: absent = off.
 *
 * The verdict reuses the fleet's shape (ResolvedClass), so the spawn
 * path downstream cannot tell which face answered.
 */
import { SpawnError } from '@broject/core';
import type { HealthSnapshot, ResolvedClass } from '@broject/core';
import { healthSnapshot, migrateStore, openStore, routerStorePath } from '@broject/router-store';
import { readRouteTable, resolveRoute, unservedChains } from '@broject/router-routes';
import type { RouteDecision, RouteTable, ServedDeclaration } from '@broject/router-routes';

/** The route a bead lands on — the lane, and the verdict behind it. The
 *  verdict is what the explanation reads: the reasons the resolver
 *  computed must not die with the lane. */
export interface RouteTableLane extends ResolvedClass {
  /** the resolver's verdict — the route, the chain, the why */
  decision: RouteDecision;
  /** the health the verdict read — the walls and the sessions */
  snapshot: HealthSnapshot;
}

/** The health — the router's own ledger. A ledger that cannot be read
 *  says NOTHING about the walls, and a caller that treats that silence
 *  as "no walls" routes into a model that is walled. The `known` flag
 *  rides the answer: the caller decides whether silence is fatal. */
async function ledgerHealth(): Promise<{ snapshot: HealthSnapshot; known: boolean }> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return { snapshot: {}, known: false };
  }
  try {
    migrateStore(handle.db);
    return { snapshot: await healthSnapshot(handle.db), known: true };
  } catch {
    return { snapshot: {}, known: false };
  } finally {
    handle.close();
  }
}

/** The task's shape — the bead's class and priority, in the table's
 *  vocabulary. A bead without a label simply has no type. */
function taskShape(opts: { class?: string; label?: string; priority?: number }) {
  const type = opts.class ?? opts.label;
  const priority = opts.priority === undefined ? undefined : `P${opts.priority}`;
  return {
    ...(type === undefined ? {} : { type }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** The wall policy — the route's own, or the fleet's priority default
 *  (P0/P1 park, P2+ fallthrough). */
function wallPolicy(
  route: { onWall?: 'park' | 'fallthrough' },
  priority?: number
): 'park' | 'fallthrough' {
  if (route.onWall !== undefined) {
    return route.onWall;
  }
  return priority !== undefined && priority <= 1 ? 'park' : 'fallthrough';
}

/** The served-universe check — a route naming a model the declaration
 *  contradicts is a config error, never a silent fallback. */
function assertServed(table: RouteTable, file: string, served: ServedDeclaration): void {
  const unserved = unservedChains(table, served);
  if (unserved.length === 0) {
    return;
  }
  const first = unserved[0]!;
  throw new SpawnError(`route table ${file} — routes.${first.route}: ${first.reason}`, 'config');
}

/** The route a bead lands on — undefined when no table is declared. */
export async function routeTableLane(opts: {
  /** the route table's path — the operator declares it in the config */
  table?: string;
  class?: string;
  label?: string;
  priority?: number;
  /** what the operator declared the router serves — the served universe */
  served?: ServedDeclaration;
}): Promise<RouteTableLane | undefined> {
  const file = opts.table;
  if (file === undefined) {
    return undefined;
  }
  let table: RouteTable;
  try {
    table = readRouteTable(file);
  } catch (err) {
    throw new SpawnError(
      `route table ${file} — ${err instanceof Error ? err.message : String(err)}`,
      'config'
    );
  }
  assertServed(table, file, opts.served ?? {});
  const { snapshot, known } = await ledgerHealth();
  if (!known) {
    // the table's walls are the health ledger's: a ledger that cannot
    // be read is not a ledger without walls — it is no answer at all,
    // and routing as if there were no walls would walk straight into a
    // walled model
    throw new SpawnError(
      'the router health ledger could not be read — the route table decides with the walls it can see, ' +
        'and a wall nobody can see is not a wall',
      'config'
    );
  }
  const decision = resolveRoute(table, taskShape(opts), snapshot);
  const route = decision.route;
  if (route === undefined) {
    return undefined;
  }
  // the SURVIVING chain, not the route's own: the resolver drops the
  // walled entries, and the lane must not point at one of them
  const head = decision.chain[0];
  if (head === undefined) {
    return undefined;
  }
  return {
    class: route.name,
    chain: decision.chain,
    onWall: wallPolicy(route, opts.priority),
    provider: head.provider,
    ...(head.model === undefined ? {} : { model: head.model }),
    decision,
    snapshot,
  };
}
