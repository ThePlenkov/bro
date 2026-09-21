#!/usr/bin/env node
/**
 * bro — agent's sidekick CLI.
 *
 * Thin host over the plugin registry — every capability is a BroPlugin
 * (subcommand + skill + config section); see plugins.ts for the list
 * and `bro plugins` for the live registry.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExternalPlugins, PLUGINS } from './plugins.ts'

// Single source of truth is package.json — dist/index.js sits one dir
// below it in both the workspace and the published tarball.
const VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
  ) as { version: string }
).version

function usage(exitCode = 1): never {
  const commands = PLUGINS.filter((p) => !p.hidden)
    .map((p) => `  ${p.name.padEnd(12)} ${p.summary}`)
    .join('\n')
  console.error(`bro — agent's sidekick CLI

Usage: bro <command> [args…]

Commands:
${commands}

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

  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION)
    return
  }
  // config `plugins` join the registry before help/dispatch — a listed
  // external command must be dispatchable, and it should show in --help
  await loadExternalPlugins()

  if (cmd === '--help' || cmd === '-h') {
    usage(0)
  }
  if (!cmd) {
    usage()
  }

  const plugin = PLUGINS.find((p) => p.name === cmd)
  if (!plugin) {
    console.error(`unknown command: ${cmd}`)
    usage()
  }
  await plugin.run([...(plugin.argvPrefix ?? []), ...rest])
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
