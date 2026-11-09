/**
 * Action `pr-gate` — `bro review act status` on the invocation's PR:
 * the link handler passes the clicked `.../pull/<N>` URL through
 * HERDR_PLUGIN_CLICKED_URL; a workspace-context call falls back to the
 * context worktree's own branch PR (act status with no arg).
 * Pure command plane — one documented bro call, no state writes.
 */
import { basename } from 'node:path';
import { broJson, ctxJson, notify, repoDir, run } from './lib.ts';

interface ActStatus {
  pr?: number;
  url?: string;
  gate?: string;
  blockers?: string[];
}

const ctx = ctxJson();
const repo = repoDir(ctx);
const dir = ctx.worktree?.checkout_path ?? repo;

const clicked = process.env.HERDR_PLUGIN_CLICKED_URL ?? (ctx.clicked_url as string | undefined);
const pr = clicked !== undefined ? /\/pull\/(\d+)/.exec(clicked)?.[1] : undefined;

// a clicked link to ANOTHER repo's PR must not show this checkout's
// same-numbered gate — bro resolves the repo from the checkout, so the
// number alone would be silently wrong
const clickedRepo =
  clicked !== undefined ? /github\.com[/:]([^/]+\/[^/]+?)\/pull\//.exec(clicked)?.[1] : undefined;
if (clickedRepo !== undefined) {
  const remote = run('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  const own = /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(remote.out.trim())?.[1];
  if (own !== undefined && own.toLowerCase() !== clickedRepo.toLowerCase()) {
    const msg = `${clickedRepo}#${pr} — not this repository (${own})`;
    notify('bro pr-gate', msg);
    console.log(msg);
    process.exit(0);
  }
}

const args = ['review', 'act', 'status', '--json'];
if (pr !== undefined) args.push(pr);

let act: ActStatus;
try {
  act = broJson<ActStatus>(args, dir);
} catch (err) {
  notify('bro pr-gate', `act status failed — ${err instanceof Error ? err.message : String(err)}`);
  throw err;
}

const label = pr !== undefined ? `#${pr}` : basename(dir);
const blockers = act.blockers ?? [];
notify(
  'bro pr-gate',
  `${label} → ${act.gate ?? 'unknown'}${blockers.length > 0 ? ` — ${blockers.join('; ')}` : ''}`
);
console.log(`${label} → ${act.gate ?? 'unknown'}${act.url !== undefined ? ` ${act.url}` : ''}`);
for (const b of blockers) console.log(`  ${b}`);
