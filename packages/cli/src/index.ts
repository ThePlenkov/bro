#!/usr/bin/env node
/**
 * bro — agent's sidekick CLI.
 *
 * Thin host over the plugin registry — every capability is a BroPlugin
 * (subcommand + skill + config section); see plugins.ts for the list
 * and `bro plugins` for the live registry.
 */
import { warnDeprecated, type BroPlugin } from '@broject/core'
import { journalCommand } from './commands/hooks.ts'
import { docUsageLines, reservedWords, runDocVerb } from './docs.ts'
import { GROUP_META, loadExternalPlugins, pluginGroups, PLUGINS } from './plugins.ts'
import { VERSION } from './version.ts'


function memberList(members: BroPlugin[]): string {
  return members
    .filter((p) => !p.hidden)
    .map((p) => (p.aliasOf ? `${p.name}→${p.aliasOf}` : p.name))
    .join(' ')
}

function memberLabel(p: BroPlugin): string {
  return p.aliasOf ? `→ ${p.aliasOf}` : p.summary
}

/** `bro <group>` with no/unknown member — the member table plus the
 *  flat-spelling reminder. */
function groupTable(cmd: string, group: BroPlugin[]): string {
  const blurb = GROUP_META.find(([g]) => g === cmd)?.[1] ?? ''
  const rows = group
    .filter((p) => !p.hidden)
    .map((p) => `  ${p.name.padEnd(12)} ${memberLabel(p)}`)
    .join('\n')
  return (
    `bro ${cmd} — ${blurb}\n\n` +
    `Members:\n${rows}\n\n` +
    `Usage: bro ${cmd} <member> [args…]   (flat spellings stay valid: bro <member> …)`
  )
}

/** Runs a group member reached via `bro <group> <member>` — the same
 *  plugin object the flat spelling hits. */
async function runMember(
  via: string,
  member: BroPlugin,
  args: string[]
): Promise<void> {
  if (member.deprecated) {
    warnDeprecated(`'bro ${via} ${member.name}'`, member.deprecated)
  }
  await member.run([...(member.argvPrefix ?? []), ...args])
}

/** Flat spelling or group host — `bro act …`, `bro mesh peers`. When
 *  argv[1] names another member of the plugin's own group, the member
 *  wins (`bro plan run` reaches `run`); every other argv shape falls
 *  to the plugin exactly as before (`bro plan`, `bro spec check`). */
async function dispatchPlugin(cmd: string, rest: string[]): Promise<boolean> {
  const plugin = PLUGINS.find((p) => p.name === cmd)
  if (!plugin) {
    return false
  }
  if (plugin.deprecated) {
    warnDeprecated(`'bro ${plugin.name}'`, plugin.deprecated)
  }
  const member = pluginGroups()
    .get(cmd)
    ?.find((p) => p.name === rest[0] && p.name !== cmd)
  if (member) {
    await runMember(cmd, member, rest.slice(1))
  } else {
    await plugin.run([...(plugin.argvPrefix ?? []), ...rest])
  }
  return true
}

/** Group dispatch — `bro review act status`. A group with no host
 *  plugin shows its member table instead of 'unknown command'. */
async function dispatchGroup(cmd: string, rest: string[]): Promise<boolean> {
  const group = pluginGroups().get(cmd)
  if (!group) {
    return false
  }
  const member = group.find((p) => p.name === rest[0])
  if (member) {
    await runMember(cmd, member, rest.slice(1))
    return true
  }
  console.error(groupTable(cmd, group))
  process.exit(rest.length === 0 ? 0 : 1)
}

function usage(exitCode = 1): never {
  const groups = pluginGroups()
  const groupRows = GROUP_META.filter(([g]) =>
    groups.get(g)?.some((p) => !p.hidden)
  )
    .map(([g, blurb]) => `  ${g.padEnd(8)} ${blurb}\n             ${memberList(groups.get(g) ?? [])}`)
    .join('\n')
  const commands = PLUGINS.filter((p) => !p.hidden && !p.group && !p.aliasOf)
    .map((p) => `  ${p.name.padEnd(12)} ${p.summary}`)
    .join('\n')
  console.error(`bro — agent's sidekick CLI

Usage: bro <command> [args…]
       bro <group> <member> [args…]

Groups:
${groupRows}

Top-level:
${commands}
${docUsageLines().join('\n')}

Options:
  --version    Print version
  --help       This text

Examples:
  bro debt collect                    # last 50 merged PRs, skip processed
  bro debt prs                        # merged PRs still unprocessed
  bro debt sync                       # project the ledger into beads
  bro act status --json               # exit gate for the current PR
  bro plugins                         # the registry — subcommand+skill+config
  bro setup`)
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)

  // command telemetry: plugins end via process.exit() — the exit event
  // is the only site that sees every path and its code. Meta commands
  // and BRO_TELEMETRY=0 skip; see journalCommand for the cheap contract
  const t0 = Date.now()
  const META_CMDS = new Set([undefined, '--version', '-v', '--help', '-h'])
  if (!META_CMDS.has(cmd)) {
    process.on('exit', (code) => {
      journalCommand(cmd as string, Date.now() - t0, code ?? 0)
    })
  }

  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION)
    return
  }
  // config `plugins` join the registry before help/dispatch — a listed
  // external command must be dispatchable, and it should show in --help.
  // Group names are reserved too — an external 'review' would shadow
  // the namespace's members without ever being reachable itself.
  await loadExternalPlugins(
    undefined,
    undefined,
    new Set([...reservedWords(), ...pluginGroups().keys()])
  )

  if (cmd === '--help' || cmd === '-h') {
    usage(0)
  }
  if (!cmd) {
    usage()
  }

  if (await dispatchPlugin(cmd, rest)) {
    return
  }
  if (await dispatchGroup(cmd, rest)) {
    return
  }
  // verb-first doc dispatch — `bro list`, `bro show <id>`, …
  if (await runDocVerb(cmd, rest)) {
    return
  }
  console.error(`unknown command: ${cmd}`)
  usage()
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
