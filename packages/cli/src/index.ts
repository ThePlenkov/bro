#!/usr/bin/env node
/**
 * bro — agent's sidekick CLI.
 *
 *   bro debt <sub>   review-debt pipeline (collect, status, prs, list, mark, sync, set)
 *   bro act <sub>    open-PR review loop (status, threads, resolve, reply)
 *   bro setup        configure a repo for bro
 *   bro --version
 */
import { runActCommand } from './commands/act.ts'
import { runDebtCommand } from './commands/debt.ts'
import { runSetupCommand } from './commands/setup.ts'

const VERSION = '0.1.0'

function usage(exitCode = 1): never {
  console.error(`bro — agent's sidekick CLI

Usage: bro <command> [args…]

Commands:
  debt <sub>   Review-debt pipeline: collect|status|prs|list|mark|sync|set
  act <sub>    Open-PR loop: status|threads|resolve|reply
  setup        Wire bro into the current repo

Options:
  --version    Print version
  --help       This text

Examples:
  bro debt collect                    # last 50 merged PRs, skip processed
  bro debt prs                        # merged PRs still unprocessed
  bro debt sync                       # project the ledger into beads
  bro act status --json               # exit gate for the current PR
  bro setup`)
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)

  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION)
    return
  }
  if (cmd === '--help' || cmd === '-h') {
    usage(0)
  }
  if (!cmd) {
    usage()
  }

  switch (cmd) {
    case 'debt':
      await runDebtCommand(rest)
      return
    case 'act':
      await runActCommand(rest)
      return
    case 'setup':
      await runSetupCommand(rest)
      return
    default:
      console.error(`unknown command: ${cmd}`)
      usage()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
