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
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface EmbeddedData {
  SKILL_FILES: Record<string, string>
  FORMULA_FILES: Record<string, string>
}

/** Reads every file under dir into {relpath: utf8}; keys are POSIX so the
 *  snapshot is byte-identical on every OS. Symlinks are never followed:
 *  recursive readdir descends into linked dirs, so a manual lstat walk
 *  keeps the snapshot inside the tree. */
function collectDir(root: string, dir: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (d: string, rel: string): void => {
    // readdir order isn't guaranteed across filesystems — sort for a
    // deterministic snapshot (check-embedded compares serialized output).
    // Code-unit compare, not localeCompare: ICU locales differ across
    // environments and must not reorder the artifact.
    for (const name of readdirSync(d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const path = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(path)
      if (st.isSymbolicLink()) {
        continue
      }
      if (st.isDirectory()) {
        walk(path, r)
      } else if (st.isFile()) {
        files[prefix + r] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(join(root, dir), '')
  return files
}

export function collectEmbedded(root: string): EmbeddedData {
  const skills: Record<string, string> = {}
  for (const entry of readdirSync(join(root, 'skills'), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) {
      continue
    }
    Object.assign(skills, collectDir(root, join('skills', entry.name), `${entry.name}/`))
  }
  return { SKILL_FILES: skills, FORMULA_FILES: collectDir(root, 'formulas') }
}
