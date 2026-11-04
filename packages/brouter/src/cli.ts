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
import { runAsk } from './ask.ts';
import { runAcpFacade } from './acp.ts';
import { runClient, runModels } from './commands.ts';
import { readRouterEndpoint } from './gateway.ts';
import { clientInventory, connectorInventory } from './agents.ts';
import { configuredProviders } from './providers.ts';
import { CLIENTS } from './registry.ts';

const USAGE = `usage:
  brouter connectors [--json]                    the connector registry
  brouter clients [--json]                       the agent clients — installed/configured/ready
  brouter providers [--json]                     the configured provider entries
  brouter ask [--provider <name>] [--model <id>] [--timeout <ms>] [--json] <question…>
                                                    ask an acp agent
  brouter acp [--provider <name>] [--model <id>]  the acp endpoint (stdio)
  brouter models [--json]                        the served catalog
  brouter clients [--json]                        the client adapters
  brouter client <id> [--write] [--settings P] [--wire] [--json]
                                                    render the model block for a client
`;

const BOOL_FLAGS = new Set(['--write', '--wire', '--json']);
const VALUE_FLAGS = new Set([
  '--settings',
  '--url',
  '--token',
  '--provider',
  '--model',
  '--timeout',
]);

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

function cmdConnectors(argv: string[]): void {
  const connectors = connectorInventory(process.cwd());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(connectors, null, 2));
    return;
  }
  for (const connector of connectors) {
    console.log(`${connector.kind}\t${connector.entries.length} entry(s)`);
    for (const entry of connector.entries) {
      console.log(`  ${entry}`);
    }
  }
}

function cmdClients(argv: string[]): void {
  const clients = clientInventory(process.cwd());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(clients, null, 2));
    return;
  }
  console.log('client\tinstalled\tconfigured\tconnector\tready');
  for (const client of clients) {
    console.log(
      [
        client.id,
        client.installed ? 'yes' : 'no',
        client.configured ?? 'no',
        client.connector ?? '-',
        client.ready ? 'yes' : 'no',
      ].join('\t')
    );
  }
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

async function cmdAsk(argv: string[]): Promise<void> {
  const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
  // pos[0] is the command word; the rest is the question
  const question = pos.slice(1).join(' ').trim();
  if (question === '') {
    console.error('error: brouter ask needs a question');
    printUsage(USAGE, 2);
  }
  const provider = flag(argv, '--provider');
  const model = flag(argv, '--model');
  const timeout = flag(argv, '--timeout');
  const outcome = await runAsk(
    {
      ...(provider === undefined ? {} : { provider }),
      question,
      ...(model === undefined ? {} : { model }),
      ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
    },
    process.cwd()
  );
  if (argv.includes('--json')) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  console.log(outcome.text);
}

async function cmdAcp(argv: string[]): Promise<void> {
  const provider = flag(argv, '--provider');
  const model = flag(argv, '--model');
  const timeout = flag(argv, '--timeout');
  await runAcpFacade(
    {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
    },
    process.cwd()
  );
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

async function cmdClient(argv: string[]): Promise<void> {
  const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
  if (pos.length === 0) {
    // no client named — the registry of clients the router can CONFIGURE
    // (the agents themselves are `brouter clients`)
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
    for (const c of CLIENTS) {
      console.log(`${c.id}\t${c.title}\t${c.settingsKey}\t${c.defaultSettingsPath}`);
    }
    return;
  }
  const client = pos[0];
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
    case 'connectors':
      cmdConnectors(argv);
      return;
    case 'clients':
      cmdClients(argv);
      return;
    case 'providers':
      cmdProviders(argv);
      return;
    case 'ask':
      await cmdAsk(argv);
      return;
    case 'acp':
      await cmdAcp(argv);
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
