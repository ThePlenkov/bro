#!/usr/bin/env node
/**
 * brouter — the model router's own CLI.
 *
 * The bin MOUNTS a command: the declarations live in plugins.ts, the
 * dispatch lives in @broject/command. Because a command is
 * self-contained, any of these can be mounted as a bin of its own.
 *
 * `client` is a tombstone for one release: the thin-client adapters
 * moved to `@broject/client-adapters` (spec bro-0ykhg.6), so the flat
 * spelling prints the new one instead of running a second copy.
 */
import { defineCommand, definePlugin, runCommand } from '@broject/command';
import { routerPlugins } from './plugins.ts';

/** `client` — moved. The compat alias prints the new spelling and
 *  stops: brouter never imports the adapters, so it cannot run them. */
function movedClientPlugin() {
  return definePlugin({
    name: 'client',
    summary: 'moved — configure a client via `bro router client` (@broject/client-adapters)',
    run: argv => {
      const rest = argv.join(' ').trim();
      console.error('brouter client moved — the client adapters are @broject/client-adapters now.');
      console.error(`run: bro router client${rest === '' ? '' : ` ${rest}`}`);
      console.error('     (standalone: client-adapters client …)');
      process.exit(1);
    },
  });
}

const cli = defineCommand({
  name: 'brouter',
  summary: 'the model router',
  plugins: [...routerPlugins(), movedClientPlugin()],
  usageLines: [
    '',
    'The router:',
    '  connectors   the kinds it speaks (acp/api/cli) and their entries',
    '  clients      the agent clients — installed / configured / ready',
    '  models       the served catalog — honest <entry>/<model> ids',
    '  client       moved — `bro router client` (@broject/client-adapters)',
    '  ask          one question to an ACP agent',
    '  acp          the ACP endpoint (stdio) in front of an agent',
  ],
  examples: [
    'brouter clients                     # the agent inventory',
    'brouter models                      # the served catalog',
    'bro router client claude-code --write  # configure Claude Code',
    'brouter ask --provider devin-acp "hello"',
  ],
});

runCommand(cli, process.argv.slice(2), { mounted: true }).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
