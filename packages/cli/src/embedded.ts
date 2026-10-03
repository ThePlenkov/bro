/**
 * The embedded capability snapshot — skills/* + formulas/* collected into
 * flat {relpath: utf8} maps that `bro setup` installs:
 *
 *   skills/*   → SKILL_FILES   (installed by `bro setup --skills`)
 *   formulas/* → FORMULA_FILES (installed by `bro setup --beads`)
 *
 * One collector, three consumers — the dev fallback in skills-data.ts, the
 * bundler plugin in tsdown.config.ts, and scripts/check-embedded.ts — so
 * the snapshot can never drift between them. The repo's skills/ and
 * formulas/ trees are the single source of truth.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface EmbeddedData {
  SKILL_FILES: Record<string, string>
  FORMULA_FILES: Record<string, string>
}

/** Reads every file under dir into {relpath: utf8}; keys are POSIX so the
 *  snapshot is byte-identical on every OS. */
function collectDir(root: string, dir: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {}
  // readdir order isn't guaranteed across filesystems — sort for a
  // deterministic snapshot (check-embedded compares serialized output).
  const entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const abs = join(entry.parentPath, entry.name)
    files[`${prefix}${relative(join(root, dir), abs).replaceAll('\\', '/')}`] = readFileSync(abs, 'utf8')
  }
  return files
}

export function collectEmbedded(root: string): EmbeddedData {
  const skills: Record<string, string> = {}
  for (const entry of readdirSync(join(root, 'skills'), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue
    }
    Object.assign(skills, collectDir(root, join('skills', entry.name), `${entry.name}/`))
  }
  return { SKILL_FILES: skills, FORMULA_FILES: collectDir(root, 'formulas') }
}
