/**
 * Ghost rebind — `<main>--*` sibling dirs on disk but absent from
 * `worktree list`, invisible to git's own prune (bro-ho09d). The sweep
 * never guesses deletion: a `.git` file pointing into THIS repo's
 * `worktrees/<name>` admin space is proof of origin — the admin dir is
 * recreated (gitdir/commondir/HEAD bound to the branch the name
 * implies) so the dir re-enters the sweep as a normal candidate.
 * Everything else is kept and reported: a `.git` directory is a
 * foreign clone, a pointer outside our admin space is foreign, a
 * missing `.git` is only removal-safe when the dir is empty, and a
 * ghost with no matching branch is human triage.
 *
 * Leaf module — imports externals only; the caller narrows the sweep
 * context to GhostSweep, so this layer never sees LitterCtx.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitTry } from '@broject/core';
import { worktreeGitDir } from '@broject/rig';
import { parseStackBranch } from '@broject/stack';

/** What one ghost's verdict + rebind needs of the litter sweep —
 *  deliberately narrower than the sweep's own ctx: the repo anchor
 *  (every git op pins -C), the admin base the `.git` pointer must name,
 *  the dry-run flag, and the report lists it writes. */
export interface GhostSweep {
  root: string;
  /** `<common-git-dir>/worktrees` — the only admin space a ghost's
   *  `.git` pointer may name and still count as ours */
  adminBase: string;
  dryRun: boolean;
  rep: { kept: string[]; repaired: string[]; reaped: string[] };
}

/** One unlisted sibling dir under sweep — its path plus the slug the
 *  `<main>--<slug>` name carries (the dir name holds the slug, not the
 *  branch namespace). */
export interface GhostDir {
  path: string;
  slug: string;
}

/** One ghost dir: classify `.git`, bind the branch the slug implies,
 *  and rebuild the admin entry the way `worktree add` would have
 *  written it — gitdir ↔ the worktree's own .git pointer, commondir
 *  back to the shared dir, HEAD pinned to the branch. `read-tree HEAD`
 *  then repopulates the index so status reads honestly (a ghost whose
 *  tip moved off its checkout reads dirty — kept, not silently reaped). */
export function recoverGhost(io: GhostSweep, g: GhostDir): void {
  const keep = (why: string): void => {
    io.rep.kept.push(`${g.path} (ghost — ${why})`);
  };
  const admin = ghostAdminDir(io, g, keep);
  if (admin === undefined) {
    return;
  }
  if (existsSync(admin)) {
    return; // registered but unlisted — worktree prune/list's business
  }
  const found = ghostBranch(io, g);
  if (found === undefined) {
    keep('no branch to bind');
    return;
  }
  if ('ambiguous' in found) {
    keep(`ambiguous branch binding — ${found.ambiguous.join(', ')}`);
    return;
  }
  if (io.dryRun) {
    io.rep.repaired.push(`${g.path} [${found.branch}]`);
    return;
  }
  const err = rebindGhostAdmin(io, g, admin, found.branch);
  if (err !== undefined) {
    keep(err);
  }
}

/** Classify the ghost's `.git`: a directory is a separate clone, an
 *  absent one is only removal-safe when the dir is empty (reaped or
 *  kept by reapEmptyGhost), a file must point inside THIS repo's admin
 *  space — anything else is foreign. Returns the admin dir a `worktree
 *  add`-shaped pointer names, undefined once the ghost is reported. */
function ghostAdminDir(
  io: GhostSweep,
  g: GhostDir,
  keep: (why: string) => void
): string | undefined {
  try {
    if (statSync(join(g.path, '.git')).isDirectory()) {
      keep('separate clone');
      return undefined;
    }
  } catch {
    reapEmptyGhost(io, g);
    return undefined;
  }
  const admin = worktreeGitDir(g.path);
  if (admin === null || dirname(admin) !== io.adminBase) {
    keep('foreign .git pointer');
    return undefined;
  }
  return admin;
}

/** A ghost with no `.git` at all — the only provably-safe removal is an
 *  empty dir; anything else is kept as unverifiable provenance. */
function reapEmptyGhost(io: GhostSweep, g: GhostDir): void {
  let empty = false;
  try {
    empty = readdirSync(g.path).length === 0;
  } catch {
    // unreadable — keep below
  }
  if (!empty) {
    io.rep.kept.push(`${g.path} (ghost — no .git — not provably a worktree)`);
    return;
  }
  if (!io.dryRun) {
    // rmdirSync, not rmSync: it refuses anything that filled in
    // between the check and the call — the guard IS the syscall
    rmdirSync(g.path);
  }
  io.rep.reaped.push(`${g.path} (empty ghost dir)`);
}

/** Recreate the admin entry and re-seat the index — the mutation half
 *  of recoverGhost, separated so the verdict reads flat. Returns the
 *  failure text when the admin write loses (a racing removal, a
 *  read-only fs), undefined when the ghost re-registered. */
function rebindGhostAdmin(
  io: GhostSweep,
  g: GhostDir,
  admin: string,
  branch: string
): string | undefined {
  try {
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(g.path, '.git')}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
  } catch (err) {
    return `admin recreate failed — ${err instanceof Error ? err.message : err}`;
  }
  gitTry(['-C', g.path, 'read-tree', 'HEAD']);
  io.rep.repaired.push(`${g.path} [${branch}]`);
  return undefined;
}

/** The branch a recovered ghost binds HEAD to — the naming
 *  convention's own mapping: loop/<slug> first, then the label
 *  namespaces (work/<slug> — a `bro work enter` tail — plus
 *  feat//fix//devin/ ad-hoc heads), else the stack member carrying
 *  <slug>. The dir name carries the slug, not the namespace: when
 *  several branches claim it the binding is a guess that can hand the
 *  tree the wrong branch's bead/PR evidence — 'ambiguous' refuses the
 *  recovery instead. */
function ghostBranch(
  io: GhostSweep,
  g: GhostDir
): { branch: string } | { ambiguous: string[] } | undefined {
  const matches = [...directSlugBranches(io, g), ...stackSlugBranches(io, g)];
  if (matches.length === 0) {
    return undefined;
  }
  return matches.length === 1 ? { branch: matches[0] } : { ambiguous: matches };
}

/** The deterministic namespaces — loop/<slug> plus the label prefixes,
 *  in convention order. */
function directSlugBranches(io: GhostSweep, g: GhostDir): string[] {
  const has = (b: string): boolean =>
    gitTry(['-C', io.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).code === 0;
  return [
    `loop/${g.slug}`,
    `work/${g.slug}`,
    `feat/${g.slug}`,
    `fix/${g.slug}`,
    `devin/${g.slug}`,
  ].filter(has);
}

/** The stack leg — any stack/<run>/<n>-<slug> member whose parsed slug
 *  matches. An unreadable branch list is no matches, same as before. */
function stackSlugBranches(io: GhostSweep, g: GhostDir): string[] {
  const st = gitTry(['-C', io.root, 'branch', '--list', 'stack/*', '--format=%(refname:short)']);
  if (st.code !== 0) {
    return [];
  }
  return st.out.split('\n').filter(b => b !== '' && parseStackBranch(b)?.slug === g.slug);
}
