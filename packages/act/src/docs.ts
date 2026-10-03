/**
 * Docs-only classification — gitignore-lite path patterns. A pattern
 * without a slash matches the basename glob (`*.md` hits `docs/x.md`);
 * one ending in `/` matches the directory at any depth (`docs/` hits
 * `a/docs/x`); anything else is a full-path glob where `*` stays inside
 * a segment and `**` crosses `/`.
 */
import { DEFAULT_CONFIG } from '@broject/core'
import type { PrTarget, ReviewFacade } from '@broject/core'

// '**/' before '**' — '**/' is zero-or-more directories, so '**/*.md'
// hits a root-level README.md, not only slashed paths
const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[^*?]+/g

function globToRe(glob: string): RegExp {
  const re = glob.replace(GLOB_TOKEN, (tok) => {
    switch (tok) {
      case '**/':
        return '(?:.*/)?'
      case '**':
        return '.*'
      case '*':
        return '[^/]*'
      case '?':
        return '[^/]'
      default:
        // literal run — escape every non-alphanumeric char
        return tok.replace(/[^a-zA-Z0-9]/g, (c) => `\\${c}`)
    }
  })
  return new RegExp(`^${re}$`)
}

export function isDocsPath(path: string, pattern: string): boolean {
  // 'docs/' is a dir at any depth — '**/docs/**' — and the dir name
  // itself may glob ('docs*/' hits docs-v2/)
  const glob = pattern.endsWith('/') ? `**/${pattern}**` : pattern
  const target = glob.includes('/')
    ? path
    : path.slice(path.lastIndexOf('/') + 1)
  return globToRe(glob).test(target)
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

/** Docs-only verdict for a PR — positive evidence only. A facade
 *  without `prFiles`, a failed fetch, or an empty diff is unknown scope
 *  and reports false: the cap may only tighten on real data. */
export function docsOnlyPr(
  rev: ReviewFacade,
  t: PrTarget,
  opts?: { docsPaths?: string[] }
): boolean {
  try {
    const files = rev.prFiles?.(t)
    return (
      files !== undefined &&
      docsOnly(files, opts?.docsPaths ?? DEFAULT_CONFIG.act.docsPaths)
    )
  } catch {
    // best-effort — same rule as reviewedShas
    return false
  }
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
