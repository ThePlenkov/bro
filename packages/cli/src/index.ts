#!/usr/bin/env node
/**
 * bro — agent's sidekick CLI.
 *
 * A THIN HOST over the command bootstrap (@broject/command): the
 * plugin registry (plugins.ts) is the content, this file is the mount.
 * Every capability is a BroPlugin (subcommand + skill + config
 * section); `bro plugins` shows the live registry.
 *
 * The tree: the root command holds the top-level plugins and one
 * command per capability group (`bro review act status` → the review
 * command → the act plugin). A group host (a plugin named like its
 * group) is reachable both ways.
 */
import { defineCommand, runCommand, type CommandPlugin } from '@broject/command';
import { EXIT, isCommandError, printUsage, type CommandError } from '@broject/core';
import { journalCommand } from './commands/hooks.ts';
import { registerTelegramSink } from './commands/sinks-telegram.ts';
import { otelSpan, setAmbient } from '@broject/providers';
import { docUsageLines, reservedWords, runDocVerb } from './docs.ts';
import { GROUP_META, loadExternalPlugins, pluginGroups, PLUGINS } from './plugins.ts';
import { VERSION } from './version.ts';

const EXAMPLES = [
  'bro review debt collect             # harvest merged-PR findings → ledger + labels',
  'bro review debt prs                 # merged PRs still unprocessed',
  'bro review debt sync                # project the ledger into beads',
  'bro review act status --json        # exit gate for the current PR',
  'bro plugins                         # the registry — subcommand+skill+config',
  'bro setup',
];

/** The capability groups as COMMANDS — the tree the root mounts. Each
 *  group command holds its members; the members stay plugins, so the
 *  flat spelling (`bro act status`) keeps working through the root.
 *
 *  The member list is a RESOLVER, not a snapshot: `prepare` loads the
 *  config's external plugins AFTER the tree is built, and an external
 *  plugin that claims a group must be reachable through it
 *  (`bro review <external>`). */
function groupCommands() {
  return GROUP_META.map(([name, summary]) => ({
    name,
    summary,
    plugins: () => (pluginGroups().get(name) ?? []) as CommandPlugin[],
  }));
}

const cli = defineCommand({
  name: 'bro',
  summary: "agent's sidekick CLI",
  version: VERSION,
  plugins: () => PLUGINS as CommandPlugin[],
  commands: groupCommands(),
  usageLines: docUsageLines(),
  examples: EXAMPLES,
  prepare: async (argv) => {
    // sink delivery policies — the plugin layer owns each type's wire
    // shape; core dispatches to whoever registered (bro-mq1t2)
    registerTelegramSink();

    // command telemetry: plugins end via process.exit() — the exit event
    // is the only site that sees every path and its code. Meta commands
    // and BRO_TELEMETRY=0 skip; see journalCommand for the cheap contract
    const cmd = argv[0];
    const t0 = Date.now();
    const META_CMDS = new Set([undefined, '--version', '-v', '--help', '-h']);
    if (!META_CMDS.has(cmd)) {
      // bro.cmd span: ambient parent for everything the command opens
      // (hook probes, acp turns, spawned workers); endDetached on exit —
      // plugins terminate via process.exit() where in-flight fetch dies,
      // so the completed span rides out on a detached node child.
      const cmdSpan = otelSpan(`bro.cmd ${cmd}`, { cmd: cmd as string }, { startMs: t0 });
      setAmbient(cmdSpan.ctx);
      process.on('exit', (code) => {
        journalCommand(cmd as string, Date.now() - t0, code ?? 0);
        cmdSpan.endDetached(
          { 'cmd.exit_code': code ?? 0, 'cmd.duration_ms': Date.now() - t0 },
          (code ?? 0) === 0 ? 'ok' : 'error'
        );
      });
    }

    // config `plugins` join the registry before help/dispatch — a listed
    // external command must be dispatchable, and it should show in --help.
    // Group names are reserved too — an external 'review' would shadow
    // the namespace's members without ever being reachable itself.
    await loadExternalPlugins(
      undefined,
      undefined,
      new Set([...reservedWords(), ...pluginGroups().keys()])
    );
  },
  fallback: async (cmd, rest) => runDocVerb(cmd, rest),
});

runCommand(cli, process.argv.slice(2), { mounted: true }).catch((err: unknown) => {
  // A command throws CommandError instead of exiting — this catch is
  // the single dispatcher exit the type exists for: usage text and
  // code ride the error, the stream follows the code (isCommandError
  // also catches a bundled duplicate module's copy of the type).
  if (isCommandError(err)) {
    const e = err;
    const code = typeof e.code === 'number' ? e.code : 1;
    // A printUsage-thrown error already wrote its usage (message===usage
    // marks that case); a directly-thrown one prints the error line then
    // its usage — exactly once each, conventional order.
    const out = code === EXIT.ok ? console.log : console.error;
    if (e.message && e.message !== e.usage) out(e.message);
    if (e.usage !== undefined && e.message !== e.usage) {
      try {
        printUsage(e.usage, e.code);
      } catch {
        // printUsage itself throws CommandError — the write already landed
      }
    }
    process.exit(code === EXIT.ok ? 0 : code);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
