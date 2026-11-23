/**
 * `bro plugins` — the BroPlugin registry: plugins FOR bro, the command
 * table with skills, config keys and plan schemas. The agents that USE
 * bro live one door over — `bro clients` owns the client × scope
 * install matrix and the adapter materializers (specs/bro-cl1.md,
 * moving the client half of specs/bro-1qpk.1.md out of this command).
 */
import { hasHelpFlag, printUsage, CommandError, EXIT, type BroPlugin } from '@broject/core';
import { runClientsCommand } from './clients.ts';

function printRegistry(plugins: BroPlugin[]): void {
  for (const p of plugins) {
    const src = p.external ? 'ext' : 'core';
    const plan = p.planSchema ? 'plan' : '-';
    console.log(
      `${p.name.padEnd(12)} ${(p.skill ?? '-').padEnd(10)} ${(p.configKey ?? '-').padEnd(8)} ${src.padEnd(4)} ${plan.padEnd(4)} ${p.summary}`
    );
  }
}

/** The registry as data — generators (command reference) read this. */
function registryRows(plugins: BroPlugin[]) {
  return plugins.map(p => ({
    name: p.name,
    group: p.group,
    summary: p.summary,
    skill: p.skill,
    configKey: p.configKey,
    hidden: p.hidden === true,
    aliasOf: p.aliasOf,
    deprecated: p.deprecated,
    plan: p.planSchema !== undefined,
    planVersion: p.planVersion,
    external: p.external === true,
  }));
}

const PLUGINS_USAGE =
  'usage: bro plugins [--json] — the BroPlugin registry (plugins for bro; client installs live under `bro clients`)';

export function runPluginsCommand(argv: string[], plugins: BroPlugin[]): void {
  const [sub, ...rest] = argv;
  if (hasHelpFlag(argv)) {
    printUsage(PLUGINS_USAGE, 0);
  }
  switch (sub) {
    case undefined:
      printRegistry(plugins);
      return;
    case '--json':
      console.log(JSON.stringify(registryRows(plugins), null, 2));
      return;
    case 'list':
      // the registry listing — the client × scope matrix moved to
      // `bro clients list`; a script reading the old shape gets one
      // stderr line naming the move
      console.error('bro plugins list moved — the client matrix lives at `bro clients list`');
      if (rest.includes('--json')) {
        console.log(JSON.stringify(registryRows(plugins), null, 2));
        return;
      }
      printRegistry(plugins);
      return;
    case 'install':
    case 'uninstall':
      // muscle-memory alias — the verb set is unchanged, only the noun
      console.error(`bro plugins ${sub} moved — use \`bro clients ${sub}\``);
      runClientsCommand(argv);
      return;
    default:
      throw new CommandError(PLUGINS_USAGE, EXIT.usage);
  }
}
