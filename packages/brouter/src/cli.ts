#!/usr/bin/env node
/**
 * brouter — the model router's own CLI.
 *
 * The bin MOUNTS a command: the declarations live in plugins.ts, the
 * dispatch lives in @broject/command. Because a command is
 * self-contained, any of these can be mounted as a bin of its own.
 */
import { defineCommand, runCommand } from '@broject/command';
import { routerPlugins } from './plugins.ts';

const cli = defineCommand({
  name: 'brouter',
  summary: 'the model router',
  plugins: routerPlugins(),
  usageLines: [
    '',
    'The router:',
    '  connectors   the kinds it speaks (acp/api/cli) and their entries',
    '  clients      the agent clients — installed / configured / ready',
    '  models       the served catalog — honest <entry>/<model> ids',
    '  client       configure a client to use the router',
    '  ask          one question to an ACP agent',
    '  acp          the ACP endpoint (stdio) in front of an agent',
  ],
  examples: [
    'brouter clients                     # the agent inventory',
    'brouter models                      # the served catalog',
    'brouter client claude-code --write  # configure Claude Code',
    'brouter ask --provider devin-acp "hello"',
  ],
});

runCommand(cli, process.argv.slice(2), { mounted: true }).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
