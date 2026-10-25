// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove
/**
 * bro's pre-tool guard for omp.
 *
 * ## Why this hook is narrow
 *
 * bro has two pre-tool planes and only one of them maps onto omp:
 *
 *   - The **permission plane** answers *approve / ask* for bro's own
 *     commands. omp's `tool_call` hook can only *block*, and omp's
 *     approval flow (`tool_approval_requested`) ignores handler
 *     returns — there is no slot for "auto-approve". So that plane is
 *     deliberately absent here: bro's machinery (`bro`, `bd`, `gh`)
 *     runs under omp's normal approval policy, and the session can
 *     approve it the same way it approves anything else.
 *
 *   - The **guard plane** answers *block* for a command that must not
 *     run. That maps exactly onto omp's `{ block: true, reason }`, and
 *     it is what this hook carries.
 *
 * ## The one rule
 *
 * A force push rewrites shared history. bro's occupancy plane — the
 * rule that one session owns one unit of work — is built on branches
 * staying stable, and other sessions and workers hold references to
 * them. A force push breaks references the rig cannot repair, so bro
 * blocks it here rather than discovering the damage at merge time.
 *
 * `--force-with-lease` is the safe form: it refuses when the remote has
 * moved, which is exactly the race a plain force push ignores.
 */
import type { OmpApi } from './omp-api.ts'

/** A force push rewrites shared history — never allowed. The command
 *  is split on shell separators first: a flag-looking word in another
 *  command must not trip the guard, and a real force push must not
 *  hide behind one. */
const SHELL_SPLIT = /&&|\|\||[;|\n|]/

/** `git [global opts] push …` — git's global options (`-C dir`,
 *  `-c k=v`, `--git-dir=…`) may sit between `git` and `push`. An
 *  option's separate value never consumes the `push` word itself. */
const PUSH_CALL = /(?:^|\s)git(?:\s+-{1,2}[^\s]+(?:\s+(?!push\b)[^\s]+)?)*\s+push\b(.*)/

/** Force spellings in the push arguments: `--force` as a whole word
 *  (never `--force-with-lease` / `--force-if-includes` — a following
 *  hyphen disqualifies), bare `-f`, or a leading-`+` refspec
 *  (`git push origin +main`). */
const FORCE_FLAG = /(?:^|\s)--force(?!-)|(?:^|\s)-f(?![\w-])|(?:^|\s)\+\S+/

/** Does any shell segment of this command force-push? */
export function isForcePush(command: string): boolean {
  return command.split(SHELL_SPLIT).some((segment) => {
    const push = PUSH_CALL.exec(segment)
    return push !== null && FORCE_FLAG.test(push[1] ?? '')
  })
}

export default function broGuard(pi: OmpApi): void {
  pi.on('tool_call', (event: unknown) => {
    const call = event as { toolName?: string; input?: unknown }
    if (call.toolName !== 'bash') {
      return undefined
    }
    const input = call.input
    // a non-string command is not a command — String() on an object would
    // produce '[object Object]' and match nothing, but it would also hide
    // the real shape behind a truthy string
    let command = ''
    if (typeof input === 'object' && input !== null && 'command' in input) {
      const raw = input.command
      command = typeof raw === 'string' ? raw : ''
    }
    if (command === '' || !isForcePush(command)) {
      return undefined
    }
    return {
      block: true,
      reason:
        "bro blocks force pushes: other sessions and bro's occupancy plane rely on stable branch history. Use --force-with-lease.",
    }
  })
}
