/**
 * `bro router` — the wrapper over the router's own CLI.
 *
 * The router is its own package (`@broject/brouter`): it serves the
 * catalog and renders it in each client's vocabulary. bro is the rig
 * around it — this command is the thin shell that lets a bro user
 * reach the router's surfaces without a second binary on PATH.
 *
 *   bro router models [--json]                      the served catalog
 *   bro router clients [--json]                     the client inventory
 *   bro router providers [--json]                   the configured providers
 *   bro router client <id> [--write] [--settings P] [--wire] [--json]
 *
 * The wrapper mounts the ROUTER'S OWN plugins (`routerPlugins()`), not a
 * second implementation: one set of commands, two spellings. What the
 * wrapper adds is POLICY — where the endpoint comes from and which
 * settings file a client gets:
 *
 *  - the endpoint comes from bro's LIVE gateway state (a dead listener
 *    is an error, not a read that never answers);
 *  - `serve.client.<id>.settingsPath` names the file the model block
 *    lands in.
 */
import { defineCommand, runCommand } from '@broject/command';
import { routerPlugins, routerUrl } from '@broject/brouter';
import type { RouterEndpoint } from '@broject/brouter';
import { flag } from './args.ts';
import { loadBroConfig } from '../plugins.ts';
import { liveServeState } from './serve.ts';

/** The gateway's own endpoint — the live state file. */
function broEndpoint(argv: string[]): RouterEndpoint {
  const url = flag(argv, '--url');
  const token = flag(argv, '--token');
  if (url !== undefined && token !== undefined) {
    return { url: routerUrl(url), token };
  }
  const live = liveServeState(process.cwd());
  if (live === undefined) {
    console.error('error: no live gateway — start one with `bro serve`');
    process.exit(1);
  }
  return { url: routerUrl(live.url), token: live.token };
}

/** The settings path the operator pinned for a client —
 *  `serve.client.<client>.settingsPath` (the machine-local layer
 *  carries it; the committed file carries the policy). */
function configuredSettingsPath(client: string): string | undefined {
  const config = loadBroConfig(process.cwd()) as {
    serve?: { client?: Record<string, { settingsPath?: string }> };
  };
  const path = config.serve?.client?.[client]?.settingsPath;
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : undefined;
}

/** The router's commands, mounted under bro. The parent path makes the
 *  help text name the command the way the user spells it (`bro router`). */
const router = defineCommand(
  {
    name: 'router',
    summary: 'The model router — the served catalog and the clients it renders for',
    plugins: routerPlugins({
      endpoint: broEndpoint,
      settingsPath: configuredSettingsPath,
    }),
  },
  'bro'
);

export async function runRouterCommand(argv: string[]): Promise<void> {
  await runCommand(router, argv);
}
