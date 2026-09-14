/**
 * Text helpers for debt records — fingerprint, preview, area derivation.
 */
import { createHash } from 'node:crypto'

/** sha256 of body|path — same nit across PRs collapses on this. */
export function fingerprint(opts: { body: string; path: string }): string {
  return createHash('sha256')
    .update(`${opts.body}|${opts.path}`)
    .digest('hex')
    .slice(0, 16)
}

export function bodyPreview(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** First two path segments — `src/foo/bar.ts` → `src/foo`. */
export function deriveArea(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, 2).join('/') || '(root)'
}
