/**
 * Action `open-worktree` — the command plane's work-enter verb:
 *
 *   selected text that looks like a slug → `bro work enter <slug>` in
 *     the repo (the plain documented call — claims/markers come from
 *     bro, not from us), then open the worktree it produced;
 *   otherwise → open the invocation context's worktree as a workspace.
 *
 * Only ever `herdr worktree open` on EXISTING trees — worktree creation
 * is bro's (`bro work enter`), never `herdr worktree create`.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bro, broStatus, ctxJson, herdr, notify, repoDir, worktreeList } from './lib.ts';

const ctx = ctxJson();
const repo = repoDir(ctx);
const wt = worktreeList(repo);
const main = wt.source?.source_checkout_path ?? repo;
const sel = (ctx.selected_text ?? '').trim();
const status = broStatus(repo);

function openExisting(path: string, label?: string): void {
  const res = herdr<{
    workspace?: { workspace_id?: string };
    root_pane?: { workspace_id?: string };
    already_open?: boolean;
  }>([
    'worktree',
    'open',
    '--cwd',
    main,
    '--path',
    path,
    '--no-focus',
    ...(label !== undefined ? ['--label', label] : []),
  ]);
  const ws = res.workspace?.workspace_id ?? res.root_pane?.workspace_id ?? '?';
  notify(
    'bro worktree open',
    `${basename(path)} → ${ws}${res.already_open === true ? ' (already open)' : ''}`
  );
  console.log(`${path} → ${ws}`);
}

function labelFor(path: string, slug: string): string {
  const claim = status.worktrees.find(w => w.path === path)?.claim ?? slug;
  return status.beads.inProgress.find(b => b.id === claim)?.title ?? claim;
}

if (/^[\w-][\w.-]*$/.test(sel)) {
  // slug selected — `bro work enter` does the enter (claim+tree), we open
  const out = bro(['work', 'enter', sel], repo);
  process.stdout.write(out);
  // re-derive the tree it made rather than parsing stdout — the git
  // worktree list is the truth plane
  const fresh = worktreeList(main);
  const expected = join(dirname(main), `${basename(main)}--${sel}`);
  const created =
    fresh.worktrees.find(w => w.path === expected) ??
    fresh.worktrees.find(w => w.branch?.endsWith(`/${sel}`) === true);
  const path = created?.path ?? (existsSync(expected) ? expected : undefined);
  if (path === undefined) {
    console.error(`work enter ran but no worktree for ${sel} resolved — check 'bro work list'`);
    process.exit(1);
  }
  openExisting(path, labelFor(path, sel));
} else {
  const p = ctx.worktree?.checkout_path;
  if (p === undefined) {
    console.error(
      'no slug selected and no worktree in context — select a slug text or invoke from a worktree workspace'
    );
    process.exit(1);
  }
  openExisting(p, labelFor(p, basename(p)));
}
