/**
 * The client surface — configure a thin client to run on the router.
 *
 * One command: `client` renders the model block in the client's own
 * words and, with `--write`, merges it into the client's settings
 * file. The catalog is read through brouter's public API; the policy
 * (where the endpoint comes from, which settings file a client gets)
 * is the host's to inject — the same `RouterPolicy` brouter's own
 * commands read.
 *
 * Every command keeps its own pieces in its own function: the request
 * it builds, the outcome it reports.
 */
import { type CommandPlugin, definePlugin } from '@broject/command';
import { flag, positionals } from '@broject/core';
import { BOOL_FLAGS, endpointFor, type RouterPolicy, VALUE_FLAGS } from '@broject/brouter';
import type { ClientOutcome, ClientRequest } from './commands.ts';
import { runClient } from './commands.ts';
import { CLIENTS } from './registry.ts';
import { formatSettingsDiff } from './settings-diff.ts';

/** The registry of clients the router can CONFIGURE — no client named. */
function renderClientRegistry(argv: string[]): void {
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
}

/** The settings file a client gets — the flag wins over the policy. */
function clientSettings(input: {
  argv: string[];
  id: string;
  policy: RouterPolicy;
}): string | undefined {
  const named = flag(input.argv, '--settings');
  if (named !== undefined) {
    return named;
  }
  return input.policy.settingsPath?.(input.id);
}

/** The client's request — what the command runs with. */
function clientRequest(input: { argv: string[]; id: string; policy: RouterPolicy }): ClientRequest {
  const settings = clientSettings(input);
  return {
    client: input.id,
    write: input.argv.includes('--write'),
    ...(settings === undefined ? {} : { settings }),
    wire: input.argv.includes('--wire'),
    json: input.argv.includes('--json'),
  };
}

/** The block alone — printed unless the wire or the write already said it. */
function printsBlock(input: { argv: string[]; written?: string }): boolean {
  if (input.argv.includes('--json')) {
    return true;
  }
  return input.written === undefined && !input.argv.includes('--wire');
}

/** What the command says after the run — the change, the wire, the block.
 *
 *  The change is said FIRST: the dry-run shows what the write would do
 *  before anything lands, and the write says the same thing after it
 *  did. With `--json` the machine shape is the block alone. */
function reportClient(input: { argv: string[]; outcome: ClientOutcome }): void {
  const outcome = input.outcome;
  if (!input.argv.includes('--json')) {
    if (outcome.written === undefined) {
      console.log('dry run — nothing written');
    } else {
      console.log(`wrote ${outcome.models.length} model row(s) → ${outcome.written}`);
    }
    console.log(formatSettingsDiff(outcome.path, outcome.changes));
  }
  if (input.argv.includes('--wire')) {
    console.log(JSON.stringify(outcome.wiring, null, 2));
  }
  if (printsBlock({ argv: input.argv, written: outcome.written })) {
    console.log(JSON.stringify(outcome.block, null, 2));
  }
}

/** `client` — the model block a client understands, written into the
 *  client's own settings. */
function clientPlugin(policy: RouterPolicy): CommandPlugin {
  return definePlugin({
    name: 'client',
    summary: 'Configure a client to use the router — the model block it understands [--write]',
    run: async argv => {
      const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
      if (pos.length === 0) {
        renderClientRegistry(argv);
        return;
      }
      const id = pos[0];
      const request = clientRequest({ argv, id, policy });
      const outcome = await runClient(request, endpointFor(policy)(argv));
      reportClient({ argv, outcome });
    },
  });
}

/** The client-adapter surface — `client`. Mounted under `bro router`
 *  (the grouped spelling) and by this package's own bin. */
export function clientAdapterPlugins(policy: RouterPolicy = {}): CommandPlugin[] {
  return [clientPlugin(policy)];
}
