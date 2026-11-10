/**
 * Event `worktree.created` — notification only: drop a mailbox line
 * through `bro notify` so sessions see herdr-side tree creation
 * on their next probe drain. Never a claim, never a spawn.
 */
import { bro, ctxJson, repoDir } from './lib.ts';

const repo = repoDir(ctxJson());
let detail = '';
try {
  const ev = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}') as Record<string, unknown>;
  const wt = ev.worktree as Record<string, unknown> | undefined;
  detail = String(wt?.path ?? wt?.checkout_path ?? ev.path ?? ev.label ?? '');
} catch {
  detail = '';
}

bro(
  ['notify', '--kind', 'herdr', '--', `herdr worktree.created${detail !== '' ? ` ${detail}` : ''}`],
  repo
);
console.log(`notified: worktree.created ${detail}`);
