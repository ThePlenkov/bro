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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

export interface LockedSkill {
  /** The skill's name — the directory under `.agents/skills/`. */
  name: string
  /** `<owner>/<repo>` — the source repo. */
  source: string
  /** How the source is fetched. `github` today; `local` for in-repo skills. */
  sourceType: string
  /** The skill's path inside the source repo. */
  skillPath: string
  /** sha256 of the source SKILL.md at lock time. */
  computedHash: string
}

export interface SkillDrift {
  name: string
  source: string
  /** The hash the lock expects. */
  expected: string
  /** The hash of what is installed — empty when the skill is missing. */
  actual: string
  /** 'missing' | 'drifted' */
  kind: 'missing' | 'drifted'
}

/** sha256 of a file's bytes. */
export function fileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
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
  const files: Array<{ relativePath: string; content: Buffer }> = []
  const collect = (current: string): boolean => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          continue
        }
        collect(full)
      } else if (entry.isFile()) {
        try {
          files.push({
            relativePath: relative(dir, full).split('\\').join('/'),
            content: readFileSync(full),
          })
        } catch {
          // an unreadable file is skipped, not fatal
        }
      }
    }
    return true
  }
  if (!collect(dir)) {
    return null
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update(file.content)
  }
  return hash.digest('hex')
}

/**
 * Read the locked skills from a `skills-lock.json`.
 *
 * Returns an empty map when the file is absent or unreadable — the caller
 * treats "no lock" as "nothing to install", never as a failure.
 */
export function readSkillLock(root: string): Map<string, LockedSkill> {
  const out = new Map<string, LockedSkill>()
  let raw: string
  try {
    raw = readFileSync(join(root, 'skills-lock.json'), 'utf8')
  } catch {
    return out
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return out
  }
  const skills = (parsed as { skills?: unknown }).skills
  if (typeof skills !== 'object' || skills === null) {
    return out
  }
  for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue
    }
    const v = value as Partial<LockedSkill>
    if (typeof v.source !== 'string' || typeof v.computedHash !== 'string') {
      continue
    }
    out.set(name, {
      name,
      source: v.source,
      sourceType: typeof v.sourceType === 'string' ? v.sourceType : 'github',
      skillPath: typeof v.skillPath === 'string' ? v.skillPath : '',
      computedHash: v.computedHash,
    })
  }
  return out
}

/**
 * Compare the installed skills against the lock.
 *
 * `skillsDir` is the `.agents/skills` directory. A skill that is missing
 * entirely is reported as `missing`; one whose content hash differs from the
 * lock is `drifted`. Skills that match are not reported — the lock's job is to
 * surface the ones that do not.
 */
export function checkSkillLock(
  locked: Map<string, LockedSkill>,
  skillsDir: string
): SkillDrift[] {
  const drift: SkillDrift[] = []
  for (const skill of locked.values()) {
    const installed = join(skillsDir, skill.name, 'SKILL.md')
    if (!existsSync(installed)) {
      drift.push({
        name: skill.name,
        source: skill.source,
        expected: skill.computedHash,
        actual: '',
        kind: 'missing',
      })
      continue
    }
    const actual = skillFolderHash(join(skillsDir, skill.name))
    if (actual !== null && actual !== skill.computedHash) {
      drift.push({
        name: skill.name,
        source: skill.source,
        expected: skill.computedHash,
        actual,
        kind: 'drifted',
      })
    }
  }
  return drift
}
