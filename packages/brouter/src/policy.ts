/**
 * The router's policy — where the answers come from.
 *
 * A host (bro's own `bro router` spelling) mounts the router's commands
 * with its own policy: where the endpoint comes from, which settings file
 * a client gets. The commands themselves never change — only the SOURCE
 * of the answer does. That is why the wrapper is a mount and never a
 * second implementation.
 */
import { flag } from '@broject/core';
import { readRouterEndpoint } from './gateway.ts';
import { routerUrl } from './endpoint.ts';
import type { RouterEndpoint } from './adapter.ts';

/** What a host may inject — the POLICY the router's commands read. */
export interface RouterPolicy {
  /** the router's endpoint — the default reads the router's state file */
  endpoint?: (argv: string[]) => RouterEndpoint;
  /** the settings file a client's model block lands in — the default is
   *  the client's own path */
  settingsPath?: (client: string) => string | undefined;
}

/** The flags the router's commands read — the boolean ones. */
export const BOOL_FLAGS = new Set(['--write', '--wire', '--json', '--explain']);

/** The flags the router's commands read — the valued ones. */
export const VALUE_FLAGS = new Set([
  '--settings',
  '--url',
  '--token',
  '--provider',
  '--model',
  '--timeout',
  '--routes',
]);

/** The router's endpoint — the flags win over the state file, so an
 *  operator can point the client half at any router. */
export function defaultEndpoint(argv: string[]): RouterEndpoint {
  const url = flag(argv, '--url');
  const token = flag(argv, '--token');
  if (url !== undefined && token !== undefined) {
    return { url: routerUrl(url), token };
  }
  const found = readRouterEndpoint(process.cwd());
  if (found === undefined) {
    console.error('brouter: no router found — start one (bro serve) or pass --url and --token');
    process.exit(1);
  }
  return found;
}

/** The endpoint a host's policy answers with — the router's own by default. */
export function endpointFor(policy: RouterPolicy): (argv: string[]) => RouterEndpoint {
  return (argv: string[]): RouterEndpoint =>
    // the policy's own endpoint, or the router's: the hook is either
    // REGISTERED or it is not — a truthiness test would say otherwise
    policy.endpoint === undefined ? defaultEndpoint(argv) : policy.endpoint(argv);
}
