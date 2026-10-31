/**
 * `bro herdr` — the hidden host for pane-facing herdr bridge helpers.
 * `status-view` is the `bro: status` pane's foreground process (spec
 * bro-idsat): renders the worktree fleet view and self-reports its own
 * `bro:fleet` LED authority. `session-view` is the `bro: session`
 * pane's (spec bro-nwl5g): attaches the worktree's recorded ACP
 * session or tails its native log. Never typed by hand — the plugin's
 * panes spawn them.
 */
import { runStatusView } from './herdr-status-view.ts';
import { runSessionView } from './herdr-session-view.ts';

export async function runHerdrCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'status-view') {
    await runStatusView(rest);
    return;
  }
  if (sub === 'session-view') {
    await runSessionView(rest);
    return;
  }
  console.error('usage: bro herdr status-view|session-view <worktree> [--once]');
  process.exit(2);
}
