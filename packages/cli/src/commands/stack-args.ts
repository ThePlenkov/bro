/**
 * `bro stack` argv layer — the flag sets, the usage text, and the two
 * name-resolution shapes every subcommand parses through. Kept free of
 * the work.ts/plugins imports the verbs need so any stack module can
 * pull it in without closing a module cycle.
 */

import type { ExitCode } from '@broject/core';
import { gitTry, printUsage } from '@broject/core';
import { isStackName, parseStackBranch } from '@broject/stack';
import { flag } from './args.ts';

export const NAME_FLAGS = new Set(['--name']);
export const MERGE_BOOL_FLAGS = new Set(['--squash', '--merge', '--rebase', '--admin']);

export function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `usage:
  bro stack push <bead> [--name <stack>]
  bro stack list [<name>]
  bro stack sync [<name>]
  bro stack publish [<name>]
  bro stack merge [<name>] [--squash|--merge|--rebase] [--admin]`,
    exitCode
  );
}

/** Stack name resolution for `push`: --name wins, else the current
 *  worktree's own `stack/<name>/…` branch (push from inside a member
 *  extends that stack), else it must be given — guessing a name would
 *  scatter branches across stacks nobody asked for. */
export function resolveStackName(argv: string[]): string {
  const explicit = flag(argv, '--name');
  if (explicit !== undefined) {
    if (!isStackName(explicit)) {
      console.error(`error: invalid stack name "${explicit}" ([a-z0-9_.-])`);
      process.exit(2);
    }
    return explicit;
  }
  const cur = parseStackBranch(gitTry(['branch', '--show-current']).out.trim());
  if (cur) {
    return cur.name;
  }
  console.error('error: no stack context — pass --name <stack>');
  usage();
}

/** Stack name resolution for the chain verbs (publish/merge): --name,
 *  a positional, or the member worktree's own branch — a missing or
 *  invalid name is a usage error, the same refusal both verbs gave
 *  inline. */
export function requiredStackName(argv: string[], pos: string[]): string {
  const name =
    flag(argv, '--name') ??
    pos[0] ??
    parseStackBranch(gitTry(['branch', '--show-current']).out.trim())?.name;
  if (name === undefined || !isStackName(name)) {
    console.error('error: no stack context — pass a name or run inside a member worktree');
    usage();
  }
  return name;
}

/** The report channel every chain verb shares — collected lines print
 *  in one pass so a member's failure lands beside its siblings. */
export function printLines(lines: readonly string[]): void {
  for (const l of lines) {
    console.log(l);
  }
}
