/**
 * `bro herdr session-view <worktree>` — the `bro: session` pane's
 * foreground process (spec bro-nwl5g → bro-l8wqu). The lifecycle core
 * lives in @broject/herdr-kit's lines module; this file is the cli
 * wiring: argv/env resolution, the config seam, and the command
 * surface (`runSessionView(argv, opts)` kept for callers/tests).
 */
import { gitCommonDir } from '@broject/core';
import {
  fleetStatusPath,
  runSessionPane,
  SESSION_PANE_AGENT,
  type SessionPaneCtx,
} from '@broject/herdr-kit';
import { flag, positionals } from './args.ts';
import { loadBroConfig } from '../plugins.ts';

/** Resolution vocabulary — moved to @broject/herdr-kit's fleet
 *  module; re-exported so existing call sites keep resolving. */
export {
  type AttachState,
  resolveTarget,
  type SessionSpec,
  type SessionTarget,
  targetKey,
  type ViewVerdict,
  viewVerdict,
} from '@broject/herdr-kit';
export { SESSION_PANE_AGENT };

/** A flag's VALUE is not a positional — `--events <path>` must not
 *  turn the archive path into the worktree arg. */
const VALUE_FLAGS = new Set(['--events', '--agent']);

/** Arg + environment resolution — `undefined` means "outside herdr,
 *  do nothing"; a missing worktree arg is the only usage error. The
 *  `--events`/`--agent` pair is the direct archive binding the pane
 *  builders carry — a native worker's journal resolves without the
 *  projector ever naming it. `flag()` fails closed on `--events=`,
 *  a missing value, or a flag-looking one — a hand-rolled indexOf
 *  silently dropped the binding. */
function viewContext(argv: string[]): SessionPaneCtx | undefined {
  // single-dash tokens are positional to positionals() — keep the
  // dash filter so `-h`/`-v` can never become the worktree arg
  const worktree = positionals(argv, VALUE_FLAGS).find(a => !a.startsWith('-'));
  if (worktree === undefined) {
    console.error(
      'usage: bro herdr session-view <worktree> [--once] [--events <path>] [--agent <id>]'
    );
    process.exit(2);
  }
  if (process.env.HERDR_ENV !== '1') return undefined;
  const pane = process.env.HERDR_PANE_ID;
  if (pane === undefined || pane === '') return undefined;
  const base = gitCommonDir(worktree) ?? worktree;
  const events = flag(argv, '--events');
  const agent = flag(argv, '--agent');
  return {
    worktree,
    pane,
    statePath: fleetStatusPath(base, worktree),
    once: argv.includes('--once'),
    ...(events !== undefined ? { events } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/** Render seam for tests — the pane's default is stdout; a test feeds
 *  a capture instead of patching the stream the TAP reporter rides. */
export interface SessionViewOpts {
  out?: (line: string) => void;
}

/** `bro herdr session-view <worktree> [--once]` — argv in, the kit's
 *  lifecycle out. Wires the bro-config providers seam. */
export async function runSessionView(argv: string[], opts: SessionViewOpts = {}): Promise<void> {
  const ctx = viewContext(argv);
  if (ctx === undefined) return;
  await runSessionPane(ctx, {
    ...(opts.out !== undefined ? { out: opts.out } : {}),
    providers: () => {
      try {
        return loadBroConfig(ctx.worktree).providers ?? {};
      } catch {
        return {};
      }
    },
  });
}
