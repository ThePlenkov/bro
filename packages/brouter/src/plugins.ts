/**
 * brouter's commands — the router's own surface, declared as plugins.
 *
 * A command is a declaration; the bootstrap turns declarations into a
 * CLI. Because the declarations are separate from the mount, any of
 * them can be mounted as a bin of its own (`brouter-ask`) without a
 * second implementation.
 *
 * The set is a FACTORY: a host (bro's own `bro router` spelling) mounts
 * the same declarations with its own policy — where the endpoint comes
 * from, which settings file a client gets. The commands themselves stay
 * ONE implementation: the wrapper is a mount, never a second switch.
 *
 * The set is split by theme, so every file holds one surface: the
 * catalog (what the router serves), the clients (who consumes it), and
 * the routes (what it serves NEXT).
 */
import type { CommandPlugin } from '@broject/command';
import { catalogPlugins } from './catalog-plugins.ts';
import { clientPlugins } from './client-plugins.ts';
import { routePlugins } from './route-plugins.ts';
import type { RouterPolicy } from './policy.ts';

export type { RouterPolicy } from './policy.ts';

/** brouter's command set — the router's own surface, one declaration
 *  each. `policy` carries the host's answers; the defaults are the
 *  router's own. */
export function routerPlugins(policy: RouterPolicy = {}): CommandPlugin[] {
  return [...catalogPlugins(policy), ...clientPlugins(policy), ...routePlugins()];
}
