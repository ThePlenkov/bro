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
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { runAcpFacade } from './acp.ts';
import { runAsk } from './ask.ts';
import { clientInventory, connectorInventory } from './agents.ts';
import { runClient, runModels } from './commands.ts';
import { configuredProviders } from './providers.ts';
import { readRouterEndpoint } from './gateway.ts';
import { CLIENTS } from './registry.ts';
import type { RouterEndpoint } from './adapter.ts';
import { flag, positionals } from '@broject/core';

const BOOL_FLAGS = new Set(['--write', '--wire', '--json']);
const VALUE_FLAGS = new Set([
  '--settings',
  '--url',
  '--token',
  '--provider',
  '--model',
  '--timeout',
]);

/** What a host may inject — the POLICY the router's commands read.
 *  The commands themselves never change; only where the answer comes
 *  from does. */
export interface RouterPolicy {
  /** the router's endpoint — the default reads the router's state file */
  endpoint?: (argv: string[]) => RouterEndpoint;
  /** the settings file a client's model block lands in — the default is
   *  the client's own path */
  settingsPath?: (client: string) => string | undefined;
}

/** The router's endpoint — the flags win over the state file, so an
 *  operator can point the client half at any router. */
function defaultEndpoint(argv: string[]): RouterEndpoint {
  const url = flag(argv, '--url');
  const token = flag(argv, '--token');
  if (url !== undefined && token !== undefined) {
    return { url: url.replace(/\/+$/, ''), token };
  }
  const found = readRouterEndpoint(process.cwd());
  if (found === undefined) {
    console.error('brouter: no router found — start one (bro serve) or pass --url and --token');
    process.exit(1);
  }
  return found;
}

/** brouter's command set — the router's own surface, one declaration
 *  each. `policy` carries the host's answers; the defaults are the
 *  router's own. */
export function routerPlugins(policy: RouterPolicy = {}): CommandPlugin[] {
  const endpoint = (argv: string[]): RouterEndpoint =>
    policy.endpoint ? policy.endpoint(argv) : defaultEndpoint(argv);

  const connectors = definePlugin({
    name: 'connectors',
    summary: 'The connector registry — the kinds (acp/api/cli) and their entries',
    run: (argv) => {
      const rows = connectorInventory(process.cwd());
      if (argv.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const connector of rows) {
        console.log(`${connector.kind}\t${connector.entries.length} entry(s)`);
        for (const entry of connector.entries) {
          console.log(`  ${entry}`);
        }
      }
    },
  });

  const clients = definePlugin({
    name: 'clients',
    summary: 'The agent clients — installed / configured / connector / ready',
    run: (argv) => {
      const rows = clientInventory(process.cwd());
      if (argv.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log('client\tinstalled\tconfigured\tconnector\tready');
      for (const client of rows) {
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
    },
  });

  const providers = definePlugin({
    name: 'providers',
    summary: 'The configured provider entries — name, kind, target, pinned model',
    run: (argv) => {
      const rows = configuredProviders(process.cwd());
      if (argv.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log('no providers configured — add providers.<name> to bro.config.json');
        return;
      }
      for (const p of rows) {
        const model = p.model === undefined ? '' : `\t${p.model}`;
        const models = p.models === undefined ? '' : `\t${p.models} model(s)`;
        console.log(`${p.name}\t${p.type}\t${p.target ?? ''}${model}${models}`);
      }
    },
  });

  const models = definePlugin({
    name: 'models',
    summary: 'The served catalog — every model the router offers, by honest id',
    run: async (argv) => {
      const { models: rows, dropped } = await runModels(endpoint(argv));
      if (argv.includes('--json')) {
        console.log(JSON.stringify({ models: rows, dropped }, null, 2));
        return;
      }
      for (const model of rows) {
        console.log(model.label === undefined ? model.id : `${model.id}\t${model.label}`);
      }
      if (dropped > 0) {
        console.error(`brouter: ${dropped} catalog row(s) carried no id — dropped`);
      }
    },
  });

  const client = definePlugin({
    name: 'client',
    summary: 'Configure a client to use the router — the model block it understands [--write]',
    run: async (argv) => {
      const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
      if (pos.length === 0) {
        // no client named — the registry of clients the router can CONFIGURE
        if (argv.includes('--json')) {
          console.log(
            JSON.stringify(
              CLIENTS.map((c) => ({
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
      const id = pos[0];
      const settings = flag(argv, '--settings') ?? policy.settingsPath?.(id);
      const outcome = await runClient(
        {
          client: id,
          write: argv.includes('--write'),
          ...(settings === undefined ? {} : { settings }),
          wire: argv.includes('--wire'),
          json: argv.includes('--json'),
        },
        endpoint(argv)
      );
      if (outcome.written !== undefined) {
        console.log(`wrote ${outcome.models.length} model row(s) → ${outcome.written}`);
      }
      if (argv.includes('--wire')) {
        console.log(JSON.stringify(outcome.wiring, null, 2));
      }
      if (argv.includes('--json') || (outcome.written === undefined && !argv.includes('--wire'))) {
        console.log(JSON.stringify(outcome.block, null, 2));
      }
    },
  });

  const ask = definePlugin({
    name: 'ask',
    summary: 'Ask an ACP agent one question — the answer printed',
    run: async (argv) => {
      const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
      const question = pos.join(' ').trim();
      if (question === '') {
        console.error('error: brouter ask needs a question');
        process.exit(2);
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
    },
  });

  const acp = definePlugin({
    name: 'acp',
    summary: 'The ACP endpoint (stdio) in front of a configured agent',
    run: async (argv) => {
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
    },
  });

  return [connectors, clients, providers, models, client, ask, acp];
}
