#!/usr/bin/env node
/**
 * bro — agent's sidekick CLI.
 *
 *   bro debt <sub>   review-debt pipeline (collect, status, prs, list, mark)
 *   bro setup        configure a repo for bro (coming in v0.2)
 *   bro --version
 */
import { runDebtCommand } from './commands/debt.ts'

const VERSION = '0.1.0'

function usage(exitCode = 1): never {
  console.error(`bro — agent's sidekick CLI

Usage: bro <command> [args…]

Commands:
  debt <sub>   Review-debt pipeline: collect|status|prs|list|mark
  setup        Wire bro into the current repo (not yet — v0.2)

Options:
  --version    Print version
  --help       This text

Examples:
  bro debt collect                    # last 50 merged PRs, skip processed
  bro debt prs                        # merged PRs still unprocessed
  bro debt status`)
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
    case 'setup':
      console.error('bro setup: not implemented yet — coming in v0.2')
      process.exit(1)
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
