/**
 * `bro skills` local-link plane — `.agents/skills/<name>` symlinks to
 * repo-owned `local:` skill dirs, created atomically and never
 * repointed silently.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** The in-repo plane ~22 agents read skills from. */
export const skillsDirOf = (root: string): string => join(root, '.agents', 'skills');

/** A name safe to be a `.agents/skills/` entry — no separators, no
 *  `..`, so frontmatter can't aim the link outside the skills dir. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RE = /^name:\s*["']?([^\s"']+)["']?\s*$/m;

/** A local skill's name — SKILL.md frontmatter `name:` when it's a
 *  safe directory name, basename fallback. */
export function localSkillName(root: string, rel: string): string {
  const dir = resolve(root, rel);
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const m = NAME_RE.exec(md);
    if (m?.[1] !== undefined && SAFE_NAME.test(m[1])) {
      return m[1];
    }
  } catch {
    // no readable SKILL.md — the caller reports the basename anyway
  }
  return basename(dir);
}

export interface LocalLink {
  name: string;
  state: 'linked' | 'present' | 'error';
  detail?: string;
}

/** `.agents/skills/<name> → <relpath>` — create via a temp-name rename
 *  (no delete-then-create gap), verify an existing link's target, and
 *  never overwrite: a real dir or a link pointing elsewhere is an
 *  error, not a repoint — bro owns links, never deletes content. */
export function ensureLocalLink(root: string, rel: string): LocalLink {
  const dir = resolve(root, rel);
  const skillsDir = skillsDirOf(root);
  const name = localSkillName(root, rel);
  if (!existsSync(join(dir, 'SKILL.md'))) {
    return { name, state: 'error', detail: `no SKILL.md at ${rel}` };
  }
  mkdirSync(skillsDir, { recursive: true });
  const link = join(skillsDir, name);
  const target = relative(skillsDir, dir);
  try {
    let st: Stats | null;
    try {
      st = lstatSync(link);
    } catch {
      st = null;
    }
    if (st === null) {
      const tmp = `${link}.bro-${process.pid}`;
      symlinkSync(target, tmp);
      renameSync(tmp, link);
      return { name, state: 'linked' };
    }
    if (!st.isSymbolicLink()) {
      return {
        name,
        state: 'present',
        detail: `.agents/skills/${name} is not a symlink — left alone`,
      };
    }
    if (resolve(skillsDir, readlinkSync(link)) === dir) {
      return { name, state: 'linked', detail: 'unchanged' };
    }
    return {
      name,
      state: 'error',
      detail: `.agents/skills/${name} already links elsewhere — not repointing`,
    };
  } catch (err) {
    return {
      name,
      state: 'error',
      detail: `link failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
