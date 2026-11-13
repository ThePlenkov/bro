#!/usr/bin/env node
/**
 * client-adapters — the thin clients' own CLI.
 *
 * The bin MOUNTS a command: the declaration lives in plugins.ts, the
 * dispatch lives in @broject/command. The same plugin is mounted under
 * `bro router client` — one implementation, two spellings.
 */
import { defineCommand, runCommand } from '@broject/command';
import { clientAdapterPlugins } from './plugins.ts';

const cli = defineCommand({
  name: 'client-adapters',
  summary: "render the router's served catalog in each client's own vocabulary",
  plugins: clientAdapterPlugins(),
  usageLines: ['', 'The clients:', '  client       configure a client to use the router'],
  examples: [
    'client-adapters client                # the adapter registry',
    'client-adapters client claude-code    # the claude-code model block',
    'client-adapters client claude-code --write  # merge it into the settings',
  ],
});

runCommand(cli, process.argv.slice(2), { mounted: true }).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
