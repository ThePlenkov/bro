/**
 * The foreign-push signal — the bus says when a PR a session armed
 * moved under it (spec bro-cqjd0).
 *
 * A session that owns a PR can have that PR's branch rewritten by
 * someone else: a review bot's auto-fix, another rig, a stray
 * `git push`. On 2026-10-20 a bot pushed onto the branch an opencode
 * session was editing, and the session found out from a non-fast-forward
 * rejection on its next push.
 *
 * The bus already knows everything needed to warn it:
 *
 * - the session's own `.act` marker names the PRs it armed;
 * - the drive's pass fetches every open PR's head SHA;
 * - the events facade can address a drop to one session.
 *
 * What was missing is the comparison. The drive keeps the last head it
 * saw per PR (its OWN memory — the act-state cache's 30s TTL is one poll
 * window, while the drive ticks every 300s, so a comparison against it
 * would never have both sides).
 *
 * The bus REPORTS; it does not coordinate. Nothing is blocked, no marker
 * is written, no branch is protected — the session knows what it pushed,
 * the bus only knows the branch moved.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitCommonDir } from '@broject/core'
import type { EventInput } from '@broject/core'
import { liveWorkEntries } from './proc-owner.ts'

/** The drive's own head memory — one file per PR under
 *  `<git-common>/bro/drive/heads/`. */
export function headMemoryPath(root: string, repo: string, pr: number): string | null {
  const common = gitCommonDir(root)
  if (common === null || common === '') {
    return null
  }
  // injective on purpose, like the act-state cache's slug: a
  // sanitizing one maps distinct valid names together ('a-b/c' and
  // 'a/b-c' both → 'a-b-c'), handing one repo's head memory to the
  // other at the same PR number
  const slug = encodeURIComponent(repo)
  return join(common, 'bro', 'drive', 'heads', `${slug}-${pr}.json`)
}

/** The last head SHA the drive saw for a PR — undefined on the first
 *  sight (that is not a change) or when the memory is unreadable. */
export function readHeadMemory(root: string, repo: string, pr: number): string | undefined {
  const path = headMemoryPath(root, repo, pr)
  if (path === null) {
    return undefined
  }
  try {
    // codacy-disable-next-line
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')) // NOSONAR — the path is bro's own common dir plus an encoded repo slug and a numeric PR
    const sha = (parsed as { sha?: unknown } | null)?.sha
    return typeof sha === 'string' && sha !== '' ? sha : undefined
  } catch {
    return undefined
  }
}

/** Remember the head the drive just saw. Fail-open: a memory that
 *  cannot be written costs the NEXT comparison, never the pass. */
export function writeHeadMemory(root: string, repo: string, pr: number, sha: string): void {
  const path = headMemoryPath(root, repo, pr)
  if (path === null) {
    return
  }
  try {
    // codacy-disable-next-line
    mkdirSync(dirname(path), { recursive: true }) // NOSONAR — the path is bro's own common dir plus an encoded repo slug and a numeric PR
    const tmp = `${path}.${process.pid}.tmp`
    // codacy-disable-next-line
    writeFileSync(tmp, JSON.stringify({ sha, at: new Date().toISOString() })) // NOSONAR — the path is bro's own common dir plus an encoded repo slug and a numeric PR
    // codacy-disable-next-line
    renameSync(tmp, path) // NOSONAR — the path is bro's own common dir plus an encoded repo slug and a numeric PR
  } catch {
    // fail-open — the signal is advisory
  }
}

/** The live sessions that armed a PR — the detail lines of every live
 *  `.act` marker, with the session that wrote it. */
export function sessionArmedPrs(hooksDir: string, pr: number): string[] {
  const want = `#${pr}`
  const out = new Set<string>()
  for (const entry of liveWorkEntries(hooksDir, ['.act'])) {
    if (entry.detail === want && entry.session !== undefined) {
      out.add(entry.session)
    }
  }
  return [...out]
}

/** The event a moved head publishes to the session that armed the PR.
 *  Keyed per PR+head so a repeat of the same head coalesces. */
export function foreignPushEvent(opts: {
  pr: number
  link: string
  from: string
  to: string
  session: string
}): EventInput {
  return {
    topic: 'drive',
    kind: 'foreign-push',
    key: `foreign-push-${opts.pr}-${opts.to}`,
    to: opts.session,
    source: 'drive',
    ref: opts.link,
    payload:
      `${opts.link} moved: head ${short(opts.from)} → ${short(opts.to)}. ` +
      'If that was not your push, another writer touched your branch — ' +
      'the bus reports the move, it does not undo it.',
  }
}

const short = (sha: string): string => (sha.length > 8 ? sha.slice(0, 8) : sha)
