/**
 * The client surface — configure a client, ask an agent, speak ACP.
 *
 * Three commands, one theme: the CONSUMERS of the served catalog. The
 * `client` command renders the model's block in a client's own words; the
 * `ask` and `acp` commands drive an agent through the router's lanes.
 *
 * Every command keeps its own pieces in its own function: the request it
 * builds, the outcome it reports. A plugin that does both in one closure
 * is a plugin whose complexity nobody can name.
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { flag, positionals } from '@broject/core';
import { runAcpFacade } from './acp.ts';
import { runAsk } from './ask.ts';
import { runClient } from './commands.ts';
import type { ClientOutcome, ClientRequest } from './commands.ts';
import { BOOL_FLAGS, VALUE_FLAGS, endpointFor, type RouterPolicy } from './policy.ts';
import { CLIENTS } from './registry.ts';

/** The lane flags every agent command reads — the provider, the model and
 *  the budget. */
interface LaneFlags {
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

/** The lane flags — the provider, the model, the budget. */
function laneFlags(argv: string[]): LaneFlags {
  const flags: LaneFlags = {};
  const provider = flag(argv, '--provider');
  if (provider !== undefined) {
    flags.provider = provider;
  }
  const model = flag(argv, '--model');
  if (model !== undefined) {
    flags.model = model;
  }
  const timeout = flag(argv, '--timeout');
  if (timeout !== undefined) {
    flags.timeoutMs = Number(timeout);
  }
  return flags;
}

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

/** What the command says after the run — the write, the wire, the block. */
function reportClient(input: { argv: string[]; outcome: ClientOutcome }): void {
  const outcome = input.outcome;
  if (outcome.written !== undefined) {
    console.log(`wrote ${outcome.models.length} model row(s) → ${outcome.written}`);
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

/** `ask` — one question to an ACP agent, the answer printed. */
function askPlugin(): CommandPlugin {
  return definePlugin({
    name: 'ask',
    summary: 'Ask an ACP agent one question — the answer printed',
    run: async argv => {
      const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
      const question = pos.join(' ').trim();
      if (question === '') {
        console.error('error: brouter ask needs a question');
        process.exit(2);
      }
      const request = { ...laneFlags(argv), question };
      const outcome = await runAsk(request, process.cwd());
      if (argv.includes('--json')) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      console.log(outcome.text);
    },
  });
}

/** `acp` — the stdio endpoint in front of a configured agent. */
function acpPlugin(): CommandPlugin {
  return definePlugin({
    name: 'acp',
    summary: 'The ACP endpoint (stdio) in front of a configured agent',
    run: async argv => {
      await runAcpFacade(laneFlags(argv), process.cwd());
    },
  });
}

/** The client surface — client, ask, acp. */
export function clientPlugins(policy: RouterPolicy): CommandPlugin[] {
  return [clientPlugin(policy), askPlugin(), acpPlugin()];
}
