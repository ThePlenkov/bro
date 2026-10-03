/**
 * Docs-only classification — gitignore-lite path patterns. A pattern
 * without a slash matches the basename glob (`*.md` hits `docs/x.md`);
 * one ending in `/` matches the directory at any depth (`docs/` hits
 * `a/docs/x`); anything else is a full-path glob where `*` stays inside
 * a segment and `**` crosses `/`.
 */

function globToRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export function isDocsPath(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return path.startsWith(pattern) || path.includes(`/${pattern}`)
  }
  const target = pattern.includes('/')
    ? path
    : path.slice(path.lastIndexOf('/') + 1)
  return globToRe(pattern).test(target)
}

/** True only when every changed path is docs — an empty file list or
 *  empty pattern list is unknown scope, not a docs PR. */
export function docsOnly(files: string[], patterns: string[]): boolean {
  return (
    files.length > 0 &&
    patterns.length > 0 &&
    files.every((f) => patterns.some((p) => isDocsPath(f, p)))
  )
}

/** The cap a docs-only PR runs under: docsMaxRounds when set, never
 *  above the general cap — the knob tightens, it never loosens. */
export function effectiveMaxRounds(
  maxRounds: number,
  docsOnlyPr: boolean,
  docsMaxRounds: number
): number {
  if (!docsOnlyPr || docsMaxRounds <= 0) {
    return maxRounds
  }
  return maxRounds > 0 ? Math.min(maxRounds, docsMaxRounds) : docsMaxRounds
}
