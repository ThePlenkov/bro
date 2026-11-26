/**
 * `bro act` argv layer — the usage text, the PR-number resolution every
 * subcommand parses through, and the small flag readers. Kept free of
 * the plugins/work imports the verbs need so any act module can pull it
 * in without closing a module cycle.
 */
import {
  CommandError,
  EXIT,
  flag,
  printUsage,
  type ExitCode,
  type PrTarget,
  type ReviewFacade,
} from '@broject/core';

export function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro act <command> [args…]

Commands:
  status [PR] [--json]              PR state + exit gate JSON
  wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup] [--bead ID] [--detach] [--json]
                                    Poll the gate until it settles; --merge lands on green,
                                    --cleanup retires the worktree + local branch after it;
                                    --bead closes the loop-claimed bead once the merge lands;
                                    --detach re-spawns the wait as its own process group —
                                    the watch survives the arming session
  threads [PR]                      Unresolved review threads (TSV)
  merge [PR] [--squash|--merge|--rebase] [--admin] [--cleanup] [--bead ID]
                                    Merge only if the exit gate is green;
                                    --cleanup also retires the worktree + local branch,
                                    --bead closes the loop-claimed bead on land
  rearm [--dry-run] [--json]        Resurrect dead watch markers: for each PR whose
                                    watcher died (host reboot, turn teardown) a fresh
                                    detached act wait goes up with the recorded mode
  resolve --thread ID [--comment T] Resolve a thread — a fix resolves silently
                                    (the push is the verdict); --comment is for
                                    reject/defer reasons
        --file TSV                  Batch resolve: <thread_id>[\t<comment>] per line —
                                    a resolve sweep over N threads in one command
        --unresolve                 resolve → unresolve instead
  reply --thread ID --comment T     Reply without resolving
        --file TSV                  Batch reply: <thread_id>\t<body> per line
  dismiss [PR] [--dry-run] [--message T]
                                    Dismiss stale veto reviews — standing
                                    CHANGES_REQUESTED reviews whose referenced
                                    threads all resolved+outdated; a live veto
                                    is refused (re-review is the reviewer's call)`,
    exitCode
  );
}

export const VALUE_FLAGS = new Set([
  '--pr',
  '--thread',
  '--comment',
  '--file',
  '--interval',
  '--timeout',
  '--bead',
  '--message',
]);

/** How a resolved target may be used: 'read' — accept the auto row and
 *  announce it; 'strict' — refuse the auto row (exit 2) because the
 *  caller pushes to the PR; 'record' — accept silently and tag the
 *  source so the caller can skip a row it cannot attribute. */
export type ResolveMode = 'read' | 'strict' | 'record';
export type ResolvedTarget = PrTarget & { source: 'explicit' | 'branch' | 'auto' };

/** PR number from argv — `--pr N` first, then the first positional. */
function prArgFrom(argv: string[]): string | null {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) {
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  // the shared flag parser — `--pr N` AND `--pr=N` spell the explicit
  // target; indexOf('--pr') missed the `=` form and let a mutation fall
  // through to the branch's PR (codeant on #1181). A bare `--pr` now
  // fails as a usage error instead of silently dropping to implicit.
  return flag(argv, '--pr') ?? positional[0] ?? null;
}

/** No explicit number — the current branch's OPEN PR, else the repo's
 *  most recently updated open PR (announced for readers, refused for
 *  anything that can push). Exits 2 when neither source exists. */
function resolveImplicit(rev: ReviewFacade, repo: string, mode: ResolveMode): ResolvedTarget {
  const pr = rev.currentPr();
  if (pr?.state === 'OPEN') {
    return { repo, pr: pr.pr, source: 'branch' };
  }
  const auto = rev.openPrs?.(repo)[0];
  if (auto === undefined) {
    console.error(
      'error: no open PR for current branch — pass a PR number (`bro act status <PR>`), or run `bro watch` for the gated-PR board'
    );
    throw new CommandError('', EXIT.usage);
  }
  const link = rev.prLink(repo, auto.pr);
  if (mode === 'strict') {
    console.error(
      `error: refusing to act on auto-resolved PR ${link} — ` + 'pass a PR number explicitly'
    );
    throw new CommandError('', EXIT.usage);
  }
  if (mode === 'read') {
    console.error(`act: resolved current PR ${link} — most recently updated open PR`);
  }
  return { repo, pr: auto.pr, source: 'auto' };
}

/** PR number: --pr flag, first positional, the current branch's PR, or
 *  the repo's most recently updated open PR per mode. */
export function resolvePr(
  rev: ReviewFacade,
  argv: string[],
  mode: ResolveMode = 'read'
): ResolvedTarget {
  const repo = rev.resolveRepo([]);
  const prRaw = prArgFrom(argv);
  if (prRaw === null) {
    return resolveImplicit(rev, repo, mode);
  }
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`error: invalid PR number "${prRaw}"`);
    throw new CommandError('', EXIT.usage);
  }
  return { repo, pr, source: 'explicit' };
}

/** resolvePr semantics without the exits — for best-effort recorders
 *  that must never interrupt the caller after the real mutation landed
 *  (bro-6mjla). Same precedence (--pr/positional → branch → recency);
 *  invalid numbers, a missing implicit PR, or a closed branch PR yield
 *  null instead of process.exit. */
export function resolvePrLenient(rev: ReviewFacade, argv: string[]): ResolvedTarget | null {
  const repo = rev.resolveRepo([]);
  const prRaw = prArgFrom(argv);
  if (prRaw !== null) {
    const pr = Number(prRaw);
    if (!Number.isInteger(pr) || pr <= 0) {
      return null;
    }
    return { repo, pr, source: 'explicit' };
  }
  const cur = rev.currentPr();
  if (cur?.state === 'OPEN') {
    return { repo, pr: cur.pr, source: 'branch' };
  }
  const auto = rev.openPrs?.(repo)[0];
  if (auto === undefined) {
    return null;
  }
  return { repo, pr: auto.pr, source: 'auto' };
}

/** Merge strategy validation — returns null (caller errors out) on
 *  conflicting flags. Runs before the slot so a doomed request never
 *  occupies the critical section. */
export function mergeMethod(argv: string[]): 'squash' | 'merge' | 'rebase' | null {
  const strategies = ['--squash', '--merge', '--rebase'].filter(f => argv.includes(f));
  if (strategies.length > 1) {
    console.error(`error: conflicting merge strategies: ${strategies.join(' ')}`);
    return null;
  }
  return (strategies[0]?.slice(2) ?? 'squash') as 'squash' | 'merge' | 'rebase';
}

export function threadArg(argv: string[]): string {
  const i = argv.indexOf('--thread');
  const id = i >= 0 ? argv[i + 1] : undefined;
  if (!id) {
    console.error('error: --thread required');
    usage();
  }
  return id!;
}

export function commentArg(argv: string[]): string | null {
  const i = argv.indexOf('--comment');
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}
