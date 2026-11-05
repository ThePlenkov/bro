/**
 * The client surface — configure a client, ask an agent, speak ACP.
 *
 * Three commands, one theme: the CONSUMERS of the served catalog. The
 * `client` command renders the model's block in a client's own words; the
 * `ask` and `acp` commands drive an agent through the router's lanes.
 */
import { definePlugin, type CommandPlugin } from '@broject/command';
import { flag, positionals } from '@broject/core';
import { runAcpFacade } from './acp.ts';
import { runAsk } from './ask.ts';
import { runClient } from './commands.ts';
import { BOOL_FLAGS, VALUE_FLAGS, endpointFor, type RouterPolicy } from './policy.ts';
import { CLIENTS } from './registry.ts';

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
      const settings = flag(argv, '--settings') ?? policy.settingsPath?.(id);
      const outcome = await runClient(
        {
          client: id,
          write: argv.includes('--write'),
          ...(settings === undefined ? {} : { settings }),
          wire: argv.includes('--wire'),
          json: argv.includes('--json'),
        },
        endpointFor(policy)(argv)
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
}

/** `acp` — the stdio endpoint in front of a configured agent. */
function acpPlugin(): CommandPlugin {
  return definePlugin({
    name: 'acp',
    summary: 'The ACP endpoint (stdio) in front of a configured agent',
    run: async argv => {
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
}

/** The client surface — client, ask, acp. */
export function clientPlugins(policy: RouterPolicy): CommandPlugin[] {
  return [clientPlugin(policy), askPlugin(), acpPlugin()];
}
