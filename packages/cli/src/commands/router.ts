/**
 * `bro router` — the wrapper over the router's own CLI.
 *
 * The router is its own package (`@broject/brouter`): it serves the
 * catalog and renders it in each client's vocabulary. bro is the rig
 * around it — this command is the thin shell that lets a bro user
 * reach the router's surfaces without a second binary on PATH.
 *
 *   bro router models [--json]                      the served catalog
 *   bro router clients [--json]                      the client adapters
 *   bro router client <id> [--write] [--settings P] [--wire] [--json]
 *
 * The endpoint comes from bro's own live state file — the gateway's
 * published `{url, token}` — so a dead listener is an error instead of
 * a read that never answers.
 */
import { runClient, runModels, type ClientOutcome } from '@broject/brouter';
import { hasHelpFlag, printUsage } from '@broject/core';
import { flag, positionals } from './args.ts';
import { loadBroConfig } from '../plugins.ts';
import { liveServeState } from './serve.ts';

const USAGE = `usage:
  bro router models [--json]                       the served catalog
  bro router clients [--json]                       the client adapters
  bro router client <id> [--write] [--settings P] [--wire] [--json]
    client        the client to render for (default: claude-code)
    --write       merge the model block into the client's settings file
    --settings    the settings file (default: the client's own)
    --wire        print the wiring (env) the client needs to reach the gateway
    --json        the model block as JSON
`;

const BOOL_FLAGS = new Set(['--write', '--wire', '--json']);

/** The gateway's own endpoint — the live state file. */
function gatewayEndpoint(): { url: string; token: string } {
  const live = liveServeState(process.cwd());
  if (live === undefined) {
    console.error('error: no live gateway — start one with `bro serve`');
    process.exit(1);
  }
  return { url: live.url, token: live.token };
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

async function cmdRouterClient(argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--settings']), { boolFlags: BOOL_FLAGS });
  if (pos.length > 1) {
    console.error('error: bro router client takes at most one client id');
    printUsage(USAGE, 2);
  }
  const client = pos[0] ?? 'claude-code';
  const flagSettings = flag(argv, '--settings');
  // the operator's own path wins over the flag's default — the flag
  // still wins over the config (an explicit answer beats a policy)
  const configured = configuredSettingsPath(client);
  const settings = flagSettings ?? configured;
  let outcome: ClientOutcome;
  try {
    outcome = await runClient(
      {
        client,
        write: argv.includes('--write'),
        ...(settings === undefined ? {} : { settings }),
        wire: argv.includes('--wire'),
        json: argv.includes('--json'),
      },
      gatewayEndpoint()
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (outcome.written !== undefined) {
    console.log(`wrote ${outcome.models.length} model row(s) → ${outcome.written}`);
  }
  if (argv.includes('--wire')) {
    console.log(JSON.stringify(outcome.wiring, null, 2));
  }
  if (argv.includes('--json') || outcome.written === undefined) {
    console.log(JSON.stringify(outcome.block, null, 2));
  }
}

export async function runRouterCommand(argv: string[]): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, 0);
  }
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === 'client') {
    await cmdRouterClient(rest);
    return;
  }
  if (command === 'models') {
    const { models, dropped } = await runModels(gatewayEndpoint());
    if (rest.includes('--json')) {
      console.log(JSON.stringify({ models, dropped }, null, 2));
      return;
    }
    for (const model of models) {
      console.log(model.label === undefined ? model.id : `${model.id}\t${model.label}`);
    }
    if (dropped > 0) {
      console.error(`bro router: ${dropped} catalog row(s) carried no id — dropped`);
    }
    return;
  }
  if (command === 'clients') {
    const { CLIENTS } = await import('@broject/brouter');
    if (rest.includes('--json')) {
      console.log(
        JSON.stringify(
          CLIENTS.map(c => ({
            id: c.id,
            title: c.title,
            settingsKey: c.settingsKey,
            settingsPath: c.defaultSettingsPath,
          })),
          null,
          2
        )
      );
      return;
    }
    for (const client of CLIENTS) {
      console.log(
        `${client.id}\t${client.title}\t${client.settingsKey}\t${client.defaultSettingsPath}`
      );
    }
    return;
  }
  console.error(USAGE);
  printUsage(USAGE, 2);
}
