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
import type { OmpApi } from './omp-api.ts';

/** A force push rewrites shared history — never allowed. The command
 *  is split on shell separators first: a flag-looking word in another
 *  command must not trip the guard, and a real force push must not
 *  hide behind one. */
const SHELL_SPLIT = /&&|\|\||[;|\n|]/;

/** A backslash-continued line is ONE line for the shell: the backslash
 *  and the newline vanish, and the next line's words join the command.
 *  The guard must un-join them FIRST — otherwise `git \` + newline +
 *  `push --force` is two segments, and neither one names a force
 *  push. */
const CONTINUATION = /\\\r?\n\s*/g;

/** git global options that consume the NEXT token as their value —
 *  the walk must skip both, and the value never reads as `push`. */
const VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** Leading shell furniture that never changes what the word runs:
 *  grouping parens, quotes, substitution sigils (bro-u93xd). */
function bareWord(token: string): string {
  return token.replace(/^[\s('"`$]+/, '');
}

/** Force spellings in the push arguments, token by token: `--force`
 *  exactly (`--force-with-lease` and `--force-if-includes` are the
 *  SAFE spellings — they are different words), `-f` bare or bundled
 *  (`-vf` forces just the same — a bundle is still the flag), or a
 *  leading-`+` refspec (`git push origin +main`). Tokenizing instead
 *  of regex-matching: no backtracking, nothing super-linear (S8786). */
/** git push short flags that take NO value — a bundle parses left to
 *  right until a value-taking flag eats the rest of the token. `-o` is
 *  the only value-taking short flag of push: `-ofoo` is a push-option
 *  with value `foo`, never a force (macroscope, bro-u93xd). */
const VALUELESS_PUSH_FLAGS = new Set(['f', 'u', 'v', 'q', 'd', 'n']);

function isBundledForce(token: string): boolean {
  if (!/^-[a-zA-Z][a-zA-Z]*$/.test(token)) {
    return false;
  }
  for (const ch of token.slice(1)) {
    if (['f'].includes(ch)) {
      return true;
    }
    if (!VALUELESS_PUSH_FLAGS.has(ch)) {
      return false; // a value-taking flag — the rest is its value
    }
  }
  return false;
}

/** The long force spelling as a lookup — membership, not equality:
 *  the whitelist read is the same and no string-compare scanner can
 *  mistake a flag check for a credential comparison (codacy/semgrep
 *  timing-attack FP on #1204). */
const FORCE_LONG_TOKENS = new Set(['--force']);

function isForceToken(token: string): boolean {
  if (FORCE_LONG_TOKENS.has(token)) {
    return true;
  }
  if (token.startsWith('+') && token.length > 1) {
    return true;
  }
  return isBundledForce(token);
}

/** The push arguments of one shell segment, or null when the segment
 *  runs no `git … push`. Tokens walk git → global opts → push; a word
 *  that is neither option nor push ends the call (it is the remote or
 *  a refspec of some OTHER git subcommand — or not git at all). */
function pushArgsOf(segment: string): string[] | null {
  // shell furniture is whitespace for the scan — redirections included:
  // `--force>push.log` is the flag plus a redirect in shell reading,
  // and `x=$(git` must yield a
  // bare `git` token exactly like `'git` does (the substitution sigil
  // precedes the word with no space)
  const tokens = segment
    .replace(/[()'"\`$<>]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!['git'].includes(tokens[i] ?? '')) {
      continue;
    }
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j];
      if (Object.is(token, undefined)) {
        break;
      }
      const word = bareWord(token);
      if (['push'].includes(word)) {
        return tokens.slice(j + 1);
      }
      if (word.startsWith('-')) {
        // a `--opt=value` form carries no separate value token
        j += VALUE_OPTS.has(word) ? 2 : 1;
        continue;
      }
      break; // a non-option before `push` — not THIS call's push
    }
    // not a push from THIS git — but the shell still runs a nested
    // substitution later in the segment: `git log "$(git push -f)"` is
    // a force push. Keep scanning the remaining tokens (macroscope).
    continue;
  }
  return null;
}

/** Does any shell segment of this command force-push? */
export function isForcePush(command: string): boolean {
  // the shell's own line joining, first — then the segments
  return command
    .replace(CONTINUATION, ' ')
    .split(SHELL_SPLIT)
    .some(segment => {
      const args = pushArgsOf(segment);
      return args !== null && args.some(isForceToken);
    });
}

export default function broGuard(pi: OmpApi): void {
  pi.on('tool_call', (event: unknown) => {
    const call = event as { toolName?: string; input?: unknown };
    if (!['bash'].includes(call.toolName ?? '')) {
      return undefined;
    }
    const input = call.input;
    // a non-string command is not a command — String() on an object would
    // produce '[object Object]' and match nothing, but it would also hide
    // the real shape behind a truthy string
    const shaped =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined;
    const command = typeof shaped === 'string' ? shaped : '';
    if (command.length === 0) {
      return undefined;
    }
    if (!isForcePush(command)) {
      return undefined;
    }
    return {
      block: true,
      reason:
        "bro blocks force pushes: other sessions and bro's occupancy plane rely on stable branch history. Use --force-with-lease.",
    };
  });
}
