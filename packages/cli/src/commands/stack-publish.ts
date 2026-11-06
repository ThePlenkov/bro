/**
 * The chain registers itself with the host — the operator's hands stay off.
 *
 * A member's PR is opened by the worker (`gh pr create`), not by bro, so
 * the chain's registration used to wait for a human to add the PRs to the
 * host's stack by hand — the operator's own words: "мне за тебя вручную
 * приходится ПРы в стек добавлять … это задача bro". The post-tool hook
 * sees the very command that creates the PR; the moment it lands, the
 * chain is registered: `bro stack publish <name>` — idempotent, and it
 * mutates no branch.
 *
 * Registration is the ONLY thing this path does. The cascade (rebase +
 * retarget) rewrites branches a live session may be working in, so it
 * stays an explicit `bro stack sync` (spec bro-awbgd).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitTry } from '@broject/core'
import { parseStackBranch } from '@broject/stack'

/** The stack a branch belongs to — undefined when the branch is not a
 *  stack member. */
export function stackNameOfBranch(branch: string): string | undefined {
  return parseStackBranch(branch)?.name
}

/** The repo's MAIN worktree — where bro's config and plugins live. A
 *  member worktree is a checkout of a branch: its config can be an
 *  older revision and an untracked plugin is simply absent, so the
 *  registration runs where every other bro invocation runs. */
function mainWorktreeDir(dir: string): string {
  const out = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']).out
  const first = out.split('\n').find((l) => l.startsWith('worktree '))
  return first?.slice('worktree '.length).trim() ?? dir
}

/** The detached child: the CLI's own entry, unref'd, so the hook never
 *  waits for the registration to land. */
function spawnStackPublish(entry: string, cwd: string, name: string): void {
  const child = spawn(process.execPath, [entry, 'stack', 'publish', name], {
    cwd,
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {})
  child.unref()
}

/** The hook half: a member's PR landed — register the chain with the
 *  host. Every failure degrades to silence: registration must never
 *  stall the session or fail a hook. */
export function maybeSpawnStackPublish(
  dir: string,
  spawnFn: (entry: string, cwd: string, name: string) => void = spawnStackPublish,
  entry: string | undefined = process.argv[1]
): void {
  try {
    const branch = gitTry(['-C', dir, 'branch', '--show-current']).out.trim()
    const name = stackNameOfBranch(branch)
    if (name === undefined) {
      return
    }
    // the child runs in the MAIN worktree — a relative entry would be
    // resolved against THAT directory, and the child would find no CLI
    if (entry === undefined || !existsSync(entry)) {
      return
    }
    spawnFn(resolve(entry), mainWorktreeDir(dir), name)
  } catch {
    // registration never affects the agent — silence is the contract
  }
}
