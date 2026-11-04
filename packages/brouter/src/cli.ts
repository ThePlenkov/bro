#!/usr/bin/env node
/**
 * brouter — the model router's own CLI.
 *
 *   brouter models [--json]                     the served catalog
 *   brouter clients [--json]                     the client adapters
 *   brouter client <id> [--write] [--settings P] [--wire] [--json]
 *
 * The router is a process: its catalog is read over HTTP from the
 * router's published endpoint. The client half is this package: the
 * model block each client understands, rendered from that catalog.
 *
 * The arg parsing is core's — the same rules the `bro` CLI follows
 * (one parser, one set of mistakes).
 */
import { flag, hasHelpFlag, positionals, printUsage } from '@broject/core';
import { runClient, runModels } from './commands.ts';
import { readRouterEndpoint } from './gateway.ts';
import { configuredProviders } from './providers.ts';
import { CLIENTS } from './registry.ts';

const USAGE = `usage:
  brouter providers [--json]                     the configured providers
  brouter models [--json]                        the served catalog
  brouter clients [--json]                        the client adapters
  brouter client <id> [--write] [--settings P] [--wire] [--json]
                                                    render the model block for a client
`;

const BOOL_FLAGS = new Set(['--write', '--wire', '--json']);
const VALUE_FLAGS = new Set(['--settings', '--url', '--token']);

function die(message: string): never {
  console.error(`brouter: ${message}`);
  process.exit(1);
}

/** The router's endpoint — the flags win over the state file, so an
 *  operator can point the client half at any router. */
function endpointOf(argv: string[]): { url: string; token: string } {
  const url = flag(argv, '--url');
  const token = flag(argv, '--token');
  if (url !== undefined && token !== undefined) {
    return { url: url.replace(/\/+$/, ''), token };
  }
  const found = readRouterEndpoint(process.cwd());
  if (found === undefined) {
    die('no router found — start one (bro serve) or pass --url and --token');
  }
  return found;
}

function cmdProviders(argv: string[]): void {
  const providers = configuredProviders(process.cwd());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(providers, null, 2));
    return;
  }
  if (providers.length === 0) {
    console.log('no providers configured — add providers.<name> to bro.config.json');
    return;
  }
  for (const p of providers) {
    const model = p.model === undefined ? '' : `\t${p.model}`;
    const models = p.models === undefined ? '' : `\t${p.models} model(s)`;
    console.log(`${p.name}\t${p.type}\t${p.target ?? ''}${model}${models}`);
  }
}

async function cmdModels(argv: string[]): Promise<void> {
  const { models, dropped } = await runModels(endpointOf(argv));
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ models, dropped }, null, 2));
    return;
  }
  for (const model of models) {
    console.log(model.label === undefined ? model.id : `${model.id}\t${model.label}`);
  }
  if (dropped > 0) {
    console.error(`brouter: ${dropped} catalog row(s) carried no id — dropped`);
  }
}

function cmdClients(argv: string[]): void {
  if (argv.includes('--json')) {
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
}

async function cmdClient(argv: string[]): Promise<void> {
  const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
  const client = pos[0] ?? 'claude-code';
  const settings = flag(argv, '--settings');
  const outcome = await runClient(
    {
      client,
      write: argv.includes('--write'),
      ...(settings === undefined ? {} : { settings }),
      wire: argv.includes('--wire'),
      json: argv.includes('--json'),
    },
    endpointOf(argv)
  );
  if (outcome.written !== undefined) {
    console.log(`wrote ${outcome.models.length} model row(s) → ${outcome.written} (modelPicker)`);
  }
  if (argv.includes('--wire')) {
    console.log(JSON.stringify(outcome.wiring, null, 2));
  }
  if (argv.includes('--json') || (outcome.written === undefined && !argv.includes('--wire'))) {
    console.log(JSON.stringify(outcome.block, null, 2));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, 0);
  }
  const command = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS })[0];
  switch (command) {
    case 'providers':
      cmdProviders(argv);
      return;
    case 'models':
      await cmdModels(argv);
      return;
    case 'clients':
      cmdClients(argv);
      return;
    case 'client':
      await cmdClient(argv);
      return;
    default:
      printUsage(USAGE, 2);
  }
}

await main();
