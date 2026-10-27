/**
 * skills-lock — the contract for skills bro does not own.
 *
 * A skill that lives in another repo is materialised into
 * `.agents/skills/` by `npx skills`, and the repo that hosts it records the
 * source in `skills-lock.json`. bro's repo carries such a lockfile for the
 * skills it consumes; nothing in bro reads it. This module is the reader.
 *
 * The lockfile is a *contract*, not an installer: it says which skill came
 * from where and what its content hash was. bro verifies the installed copy
 * against that hash and reports drift — a skill whose content no longer
 * matches the lock is a finding, not a silent update.
 *
 * Fail-open throughout. A missing lockfile, a malformed entry, an absent
 * skill directory — all read as "nothing to report", never a crash.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

export interface LockedSkill {
  /** The skill's name — the directory under `.agents/skills/`. */
  name: string;
  /** `<owner>/<repo>` — the source repo. It must be a **public** repo: bro
   *  is public, and a lock entry a contributor cannot resolve makes
   *  `bro setup --lock` fail for them over a skill they never meant to
   *  install. */
  source: string;
  /** How the source is fetched. `github` today; `local` for in-repo skills. */
  sourceType: string;
  /** The skill's path inside the source repo. */
  skillPath: string;
  /** sha256 of the skill FOLDER at lock time — every file in the skill
   *  folder, sorted by relative path, path and content fed into the digest. */
  computedHash: string;
  /** The revision the source was pinned at (a commit sha or a tag). Empty
   *  when the lock pins none — an unpinned entry is fetched from the source's
   *  default branch, which is not reproducible. */
  ref: string;
}

export interface SkillDrift {
  name: string;
  source: string;
  /** The hash the lock expects. */
  expected: string;
  /** The hash of what is installed — empty when the skill is missing. */
  actual: string;
  /** 'missing' | 'drifted' */
  kind: 'missing' | 'drifted';
}

/**
 * The hash a skill folder hashes to — the shape `skills-lock.json` stores.
 *
 * `npx skills` computes it as sha256 over every file in the skill folder,
 * sorted by relative path, feeding each file's path and content into the
 * digest in that order. `.git` and `node_modules` are skipped, and so is
 * anything that is not a regular file (a symlink is not followed).
 *
 * Hashing the folder and not just `SKILL.md` is the point: a skill whose
 * helper scripts changed has changed, even when its instructions did not.
 */
export function skillFolderHash(dir: string): string | null {
  const files = collectSkillFiles(dir);
  // any unlistable directory fails the hash — a partial hash would
  // vouch for content it never covered (the drift contract)
  if (files === null) {
    return null;
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

interface SkillFileEntry {
  relativePath: string;
  content: Buffer;
}

/** Every regular file under `dir`, breadth-first — null the moment a
 *  directory cannot be listed. */
function collectSkillFiles(dir: string): SkillFileEntry[] | null {
  const files: SkillFileEntry[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      visitSkillEntry({ dir, current, entry, files, pending });
    }
  }
  return files;
}

interface SkillWalk {
  /** The hashing root — relativePaths are computed against it. */
  dir: string;
  current: string;
  entry: Dirent;
  files: SkillFileEntry[];
  pending: string[];
}

function visitSkillEntry(walk: SkillWalk): void {
  const full = join(walk.current, walk.entry.name);
  if (walk.entry.isDirectory()) {
    if (walk.entry.name !== '.git' && walk.entry.name !== 'node_modules') {
      walk.pending.push(full);
    }
    return;
  }
  if (!walk.entry.isFile()) {
    return;
  }
  try {
    walk.files.push({
      relativePath: relative(walk.dir, full).split('\\').join('/'),
      content: readFileSync(full),
    });
  } catch {
    // an unreadable file is skipped, not fatal
  }
}

/**
 * Read the locked skills from a `skills-lock.json`.
 *
 * Returns an empty map when the file is absent or unreadable — the caller
 * treats "no lock" as "nothing to install", never as a failure.
 */
export function readSkillLock(root: string): Map<string, LockedSkill> {
  const out = new Map<string, LockedSkill>();
  let raw: string;
  try {
    raw = readFileSync(join(root, 'skills-lock.json'), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  for (const [name, value] of Object.entries(skillsOf(parsed))) {
    const skill = lockedSkill({ name, value });
    if (skill !== null) {
      out.set(name, skill);
    }
  }
  return out;
}

/** The `skills` map of a parsed lockfile — empty when the shape is wrong. */
function skillsOf(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  const skills = (parsed as { skills?: unknown }).skills;
  if (typeof skills !== 'object' || skills === null) {
    return {};
  }
  return skills as Record<string, unknown>;
}

/** One lock entry — null when it carries no source or no hash. */
function lockedSkill(entry: { name: string; value: unknown }): LockedSkill | null {
  const { name, value } = entry;
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as Partial<LockedSkill>;
  if (typeof v.source !== 'string' || typeof v.computedHash !== 'string') {
    return null;
  }
  return {
    name,
    source: v.source,
    sourceType: typeof v.sourceType === 'string' ? v.sourceType : 'github',
    skillPath: typeof v.skillPath === 'string' ? v.skillPath : '',
    computedHash: v.computedHash,
    ref: typeof v.ref === 'string' ? v.ref : '',
  };
}

/**
 * Compare the installed skills against the lock.
 *
 * `skillsDir` is the `.agents/skills` directory. A skill that is missing
 * entirely is reported as `missing`; one whose content hash differs from the
 * lock is `drifted`. Skills that match are not reported — the lock's job is to
 * surface the ones that do not.
 */
export function checkSkillLock(locked: Map<string, LockedSkill>, skillsDir: string): SkillDrift[] {
  const drift: SkillDrift[] = [];
  for (const skill of locked.values()) {
    const skillDrift = checkSingleSkill(skill, skillsDir);
    if (skillDrift !== null) {
      drift.push(skillDrift);
    }
  }
  return drift;
}

function checkSingleSkill(skill: LockedSkill, skillsDir: string): SkillDrift | null {
  const installedDir = join(skillsDir, skill.name);
  const installedSkillMd = join(installedDir, 'SKILL.md');
  if (!existsSync(installedSkillMd)) {
    return driftOf(skill, { actual: '', kind: 'missing' });
  }
  const actual = skillFolderHash(installedDir);
  // A folder that cannot be fully read (an unreadable file, an unlistable
  // subdirectory) hashes to null. Treating that as "no drift" would
  // vouch for content the hash never covered, so it is drift.
  if (actual === null) {
    return driftOf(skill, { actual: '', kind: 'drifted' });
  }
  if (actual !== skill.computedHash) {
    return driftOf(skill, { actual, kind: 'drifted' });
  }
  return null;
}

function driftOf(skill: LockedSkill, result: Pick<SkillDrift, 'actual' | 'kind'>): SkillDrift {
  return {
    name: skill.name,
    source: skill.source,
    expected: skill.computedHash,
    actual: result.actual,
    kind: result.kind,
  };
}
