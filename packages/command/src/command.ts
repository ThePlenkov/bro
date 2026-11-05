/**
 * The command tree and its dispatch — the generic bootstrap.
 *
 * A command holds PLUGINS (leaf commands) and COMMANDS (nested
 * commands). The rules are bro's, generalized — they were proven on a
 * hundred-command CLI:
 *
 *  - a plugin wins over a command of the same name (the host case);
 *  - a host's own members win over the host when argv names one;
 *  - a nested command with no member named prints its member table
 *    (exit 0 for `--help`, exit 2 for an unknown member);
 *  - the flat-spelling retirement warning fires only for a truly flat
 *    invocation;
 *  - `help <cmd>` is `<cmd> --help`.
 */
import { EXIT, printUsage, warnDeprecated, type ExitCode } from './exits.ts';
import type { CommandPlugin } from './plugin.ts';

/** A command's members — a list, or a RESOLVER that returns the list
 *  at dispatch time. The resolver is the late-joining case: a host
 *  loads external plugins (from config) after the tree is built, so a
 *  snapshot taken at build time would hide them from their own group.
 *  The list is read when the command dispatches, never before. */
export type PluginSource = CommandPlugin[] | (() => CommandPlugin[]);

/** A command's declaration. */
export interface CommandSpec {
  /** the command's name — the argv token that reaches it */
  name: string;
  /** the one-liner in the parent's member table */
  summary?: string;
  /** the leaf commands */
  plugins?: PluginSource;
  /** the nested commands */
  commands?: CommandSpec[];
  /** extra usage lines under the command table */
  usageLines?: string[];
  /** the examples block */
  examples?: string[];
  /** the version `--version` prints */
  version?: string;
  /** the host's own setup, before any dispatch */
  prepare?: (argv: string[]) => Promise<void>;
  /** the last-resort resolver — a host's own noun/verb layer */
  fallback?: (cmd: string, rest: string[]) => Promise<boolean>;
}

/** A resolved command — the spec plus its own members. */
export interface Command {
  readonly name: string;
  /** the full path — `mytool db` — the help text names it */
  readonly path: string;
  /** the MOUNTED command's path — the flat spelling a member table
   *  points at (`mytool <member>`), even from a nested command */
  readonly rootPath: string;
  readonly summary?: string;
  readonly plugins: PluginSource;
  readonly commands: Command[];
  readonly usageLines?: string[];
  readonly examples?: string[];
  readonly version?: string;
  readonly prepare?: (argv: string[]) => Promise<void>;
  readonly fallback?: (cmd: string, rest: string[]) => Promise<boolean>;
}

/** Identity helper — typed declaration sites, same role as definePlugin. */
export function defineCommand(
  spec: CommandSpec,
  parentPath?: string,
  rootPath?: string
): Command {
  const path = parentPath === undefined ? spec.name : `${parentPath} ${spec.name}`;
  const root = rootPath ?? path;
  return {
    name: spec.name,
    path,
    rootPath: root,
    ...(spec.summary === undefined ? {} : { summary: spec.summary }),
    plugins: spec.plugins ?? [],
    commands: (spec.commands ?? []).map((c) => defineCommand(c, path, root)),
    ...(spec.usageLines === undefined ? {} : { usageLines: spec.usageLines }),
    ...(spec.examples === undefined ? {} : { examples: spec.examples }),
    ...(spec.version === undefined ? {} : { version: spec.version }),
    ...(spec.prepare === undefined ? {} : { prepare: spec.prepare }),
    ...(spec.fallback === undefined ? {} : { fallback: spec.fallback }),
  };
}

/** The members a command holds — the list, or the resolver's answer
 *  at the moment it is asked for. */
export function pluginsOf(command: Command): CommandPlugin[] {
  return typeof command.plugins === 'function' ? command.plugins() : command.plugins;
}

/** The members a command lists — its own plugins plus the plugins of
 *  its nested commands, each name once. */
export function membersOf(command: Command): CommandPlugin[] {
  const seen = new Set<string>();
  const out: CommandPlugin[] = [];
  for (const p of [
    ...pluginsOf(command),
    ...command.commands.flatMap((c) => pluginsOf(c)),
  ]) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

function memberList(members: CommandPlugin[]): string {
  return members
    .filter((p) => !p.hidden)
    .map((p) => (p.aliasOf ? `${p.name}→${p.aliasOf}` : p.name))
    .join(' ');
}

function memberLabel(p: CommandPlugin): string {
  return p.aliasOf ? `→ ${p.aliasOf}` : p.summary;
}

/** The member table of a command — what a bare or unknown member asks for. */
export function groupTable(command: Command, group: CommandPlugin[]): string {
  const rows = group
    .filter((p) => !p.hidden)
    .map((p) => `  ${p.name.padEnd(12)} ${memberLabel(p)}`)
    .join('\n');
  return (
    `${command.path} — ${command.summary ?? ''}\n\n` +
    `Members:\n${rows}\n\n` +
    `Usage: ${command.path} <member> [args…]   (flat spellings stay valid: ${command.rootPath} <member> …)`
  );
}

/** The help text of a command. */
export function usageText(command: Command): string {
  const groups = command.commands
    .filter((c) => membersOf(c).some((p) => !p.hidden))
    .map(
      (c) =>
        `  ${c.name.padEnd(8)} ${c.summary ?? ''}\n             ${memberList(membersOf(c))}`
    )
    .join('\n');
  // a grouped plugin belongs to its group's table, not the top-level one
  const commands = pluginsOf(command)
    .filter((p) => !p.hidden && !p.aliasOf && !p.group)
    .map((p) => `  ${p.name.padEnd(12)} ${p.summary}`)
    .join('\n');
  const usage = command.usageLines ?? [];
  const examples = command.examples ?? [];
  // a CLI with no groups prints no Groups block — an empty section is
  // noise, not structure
  const groupsBlock = groups === '' ? '' : `Groups:\n${groups}\n\n`;
  return `${command.path} — ${command.summary ?? 'the CLI'}

Usage: ${command.path} <command> [args…]
       ${command.path} <group> <member> [args…]

${groupsBlock}Top-level:
${commands}
${usage.join('\n')}

Options:
  --version    Print version
  --help       This text (also: ${command.path} help, ${command.path} help <cmd>)

Examples:
${examples.map((e) => `  ${e}`).join('\n')}`
}

/** Runs a member reached via `<cli> <group> <member>`. */
async function runMember(
  command: Command,
  via: string,
  member: CommandPlugin,
  args: string[]
): Promise<void> {
  if (member.deprecated) {
    warnDeprecated(`'${command.path} ${via} ${member.name}'`, member.deprecated);
  }
  await member.run([...(member.argvPrefix ?? []), ...args]);
}

/** Resolve one argv against a command: a plugin, a nested command, or
 *  the command's member table. */
async function resolve(command: Command, argv: string[]): Promise<boolean> {
  const [head, ...rest] = argv;
  if (head === undefined) {
    return false;
  }
  const plugin = pluginsOf(command).find((p) => p.name === head);
  const nested = command.commands.find((c) => c.name === head);
  if (plugin !== undefined) {
    // the host case: the nested command's own members win when argv
    // names one — the host plugin itself never matches (its own name
    // is the command's name)
    if (nested !== undefined) {
      const member = pluginsOf(nested).find((p) => p.name === rest[0] && p.name !== head);
      if (member !== undefined) {
        await runMember(command, nested.name, member, rest.slice(1));
        return true;
      }
    }
    if (plugin.deprecated !== undefined) {
      warnDeprecated(`'${command.path} ${plugin.name}'`, plugin.deprecated);
    }
    // flat-spelling retirement: only a truly flat invocation warns —
    // `<cli> <host> <member>` resolves the member above and stays
    // silent. A group host has no better spelling than itself.
    // FLAT means the CLI's OWN top-level table: inside a nested command
    // the plugin was reached through its group, which is the spelling
    // the warning points at.
    if (
      command.path === command.rootPath &&
      plugin.deprecated === undefined &&
      plugin.flatDeprecated !== undefined &&
      plugin.group !== undefined &&
      plugin.group !== plugin.name
    ) {
      warnDeprecated(
        `'${command.path} ${plugin.name}'`,
        `${plugin.flatDeprecated} — prefer '${command.path} ${plugin.group} ${plugin.name}'`
      );
    }
    await plugin.run([...(plugin.argvPrefix ?? []), ...rest]);
    return true;
  }
  if (nested !== undefined) {
    const first = rest[0];
    if (first === undefined || first === '-h' || first === '--help') {
      printUsage(groupTable(nested, membersOf(nested)), EXIT.ok);
      return true;
    }
    await runCommand(nested, rest);
    return true;
  }
  return false;
}

/** Run one command over argv. `mounted` marks the CLI's root: its
 *  fallthrough is the usage text, a nested command's is its member
 *  table. */
export async function runCommand(
  command: Command,
  argv: string[],
  opts: { mounted?: boolean } = {}
): Promise<void> {
  // `<cli> help` is `<cli> --help`; `<cli> help <cmd>…` is
  // `<cli> <cmd>… --help` — one spelling for explicit help whichever
  // side of the command it sits on
  let args = argv;
  if (args[0] === 'help') {
    const tail = args.slice(1);
    const sep = tail.indexOf('--');
    const head = sep === -1 ? tail : tail.slice(0, sep);
    args = head.length === 0 ? ['--help'] : [...head, '--help'];
  }
  const [cmd, ...rest] = args;

  await command.prepare?.(args);

  if (cmd === '--version' || cmd === '-v') {
    console.log(command.version ?? '');
    return;
  }
  if (cmd === '--help' || cmd === '-h') {
    printUsage(usageText(command), EXIT.ok);
  }
  if (!cmd) {
    // bare `<cli>` — the failure code every bro-family CLI used (1),
    // not the usage code (2). A nested command with members asks for
    // its table instead: the member list IS its help.
    if (opts.mounted !== true && membersOf(command).length > 0) {
      printUsage(groupTable(command, membersOf(command)), EXIT.ok);
    }
    printUsage(usageText(command), EXIT.error);
  }

  if (await resolve(command, args)) {
    return;
  }
  if (command.fallback && (await command.fallback(cmd, rest))) {
    return;
  }
  const members = membersOf(command);
  if (opts.mounted !== true && members.length > 0) {
    // the UNKNOWN token is argv[0] here — it is what makes this a usage
    // error rather than a bare command
    printUsage(groupTable(command, members), EXIT.usage);
  }
  console.error(`unknown command: ${cmd}`);
  printUsage(usageText(command), EXIT.usage);
}
