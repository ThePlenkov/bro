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
import type { ResolvedClass } from '@broject/core';
import { healthSnapshot, migrateStore, openStore, routerStorePath } from '@broject/router-store';
import { readRouteTable, resolveRoute } from '@broject/router-routes';
import type { RouteTable } from '@broject/router-routes';

/** The health — the router's own ledger. A ledger that cannot be read
 *  is no wall at all: the decision degrades, the run continues. */
async function ledgerHealth(): Promise<Awaited<ReturnType<typeof healthSnapshot>>> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return {};
  }
  try {
    await migrateStore(handle.db);
    return await healthSnapshot(handle.db);
  } catch {
    return {};
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

/** The route a bead lands on — undefined when no table is declared. */
export async function routeTableLane(opts: {
  /** the route table's path — the operator declares it in the config */
  table?: string;
  class?: string;
  label?: string;
  priority?: number;
}): Promise<ResolvedClass | undefined> {
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
  const health = await ledgerHealth();
  const decision = resolveRoute(table, taskShape(opts), health);
  const route = decision.route;
  if (route === undefined) {
    return undefined;
  }
  const head = route.chain[0];
  if (head === undefined) {
    return undefined;
  }
  return {
    class: route.name,
    chain: route.chain,
    onWall: wallPolicy(route, opts.priority),
    provider: head.provider,
    ...(head.model === undefined ? {} : { model: head.model }),
  };
}
