/**
 * `bro herdr` — the hidden host for pane-facing herdr bridge helpers.
 * `status-view` is the `bro: status` pane's foreground process (spec
 * bro-idsat): renders the worktree fleet view and self-reports its own
 * `bro:fleet` LED authority. Never typed by hand — the plugin's pane
 * spawns it.
 */
import { runStatusView } from './herdr-status-view.ts';

export async function runHerdrCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'status-view') {
    await runStatusView(rest);
    return;
  }
  console.error(`usage: bro herdr status-view <worktree> [--once]`);
  process.exit(2);
}
