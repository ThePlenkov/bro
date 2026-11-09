/**
 * The catalog surface — what the router serves and who it talks to.
 *
 * Four commands, one theme: the router's own inventory. The served
 * catalog, the connectors behind it, the clients it can configure, and
 * the provider entries it serves from.
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { clientInventory, connectorInventory } from './agents.ts';
import { runModels } from './commands.ts';
import { configuredProviders } from './providers.ts';
import { endpointFor, type RouterPolicy } from './policy.ts';

/** The connectors — the kinds the router speaks, and their entries. */
function connectorsPlugin(): CommandPlugin {
  return definePlugin({
    name: 'connectors',
    summary: 'The connector registry — the kinds (acp/api/cli) and their entries',
    run: argv => {
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
}

/** The agent clients — installed, configured, connector, ready. */
function clientsPlugin(): CommandPlugin {
  return definePlugin({
    name: 'clients',
    summary: 'The agent clients — installed / configured / connector / ready',
    run: argv => {
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
}

/** The configured provider entries. */
function providersPlugin(): CommandPlugin {
  return definePlugin({
    name: 'providers',
    summary: 'The configured provider entries — name, kind, target, pinned model',
    run: argv => {
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
}

/** The served catalog — every model the router offers, by honest id. */
function modelsPlugin(policy: RouterPolicy): CommandPlugin {
  const endpoint = endpointFor(policy);
  return definePlugin({
    name: 'models',
    summary: 'The served catalog — every model the router offers, by honest id',
    run: async argv => {
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
}

/** The catalog surface — connectors, clients, providers, models. */
export function catalogPlugins(policy: RouterPolicy): CommandPlugin[] {
  return [connectorsPlugin(), clientsPlugin(), providersPlugin(), modelsPlugin(policy)];
}
