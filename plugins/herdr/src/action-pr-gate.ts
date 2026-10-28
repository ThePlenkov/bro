/**
 * Action `pr-gate` — `bro review act status` on the invocation's PR:
 * the link handler passes the clicked `.../pull/<N>` URL through
 * HERDR_PLUGIN_CLICKED_URL; a workspace-context call falls back to the
 * context worktree's own branch PR (act status with no arg).
 * Pure command plane — one documented bro call, no state writes.
 */
import { basename } from 'node:path';
import { broJson, ctxJson, notify, repoDir } from './lib.ts';

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
