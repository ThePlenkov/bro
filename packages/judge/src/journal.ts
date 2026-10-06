/**
 * The verdict journal — `<git-common-dir>/bro/judge/verdicts.jsonl`,
 * one JSONL row per recorded decide() or observed disposition (spec:
 * specs/sessions/bro-f4ot.2-judge.md §shadow mode). Shadow means the
 * verdict exists durably so it can be scored; the journal never feeds
 * the gate.
 *
 * The common git dir is the shared plane for the same reason
 * agents.json and hook traces live there: linked worktrees share it,
 * nothing lands in git, `bro sync` can ship it. Scope is kind-generic
 * — 'act-thread' is the v1 surface; verdicts beside hook-prompt
 * composition decisions (stop-gate questions like 'spec followed?')
 * append the same way under their own kind.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitTry } from '@broject/core'
import type {
  Disposition,
  JournalRow,
  ReviewComment,
  Verdict,
} from '@broject/core'

/** The journal file for `dir` — `<git-common>/bro/judge/verdicts.jsonl`;
 *  null outside a repo (the same relative/absolute fallback chain
 *  mailboxDir uses). */
export function journalPath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  let common = r.code === 0 ? r.out.trim() : ''
  if (common === '') {
    const rel = gitTry(['-C', dir, 'rev-parse', '--git-common-dir'])
    common = rel.code === 0 && rel.out.trim() !== '' ? resolve(dir, rel.out.trim()) : ''
  }
  return common === '' ? null : join(common, 'bro', 'judge', 'verdicts.jsonl')
}

/** The subject's dedup key — a content hash of the first comment the
 *  facade exposes. A thread whose inputs moved (edit, new finding
 *  revision) hashes differently and earns a fresh decide(); an
 *  unchanged thread re-reads its verdict for free. */
export function commentKey(c: ReviewComment): string {
  // JSON.stringify frames the tuple — a bare join lets distinct
  // path/line pairs collide into one key
  return createHash('sha256')
    .update(JSON.stringify([c.author, c.createdAt, c.path, c.line, c.body]))
    .digest('hex')
    .slice(0, 16)
}

/** The subject identity for one thread — `pr`/`headSha` give the
 *  verdict its context; `threadId` + `commentSha` are the join key
 *  dispositions and dedup match on. */
export function threadSubject(
  pr: number | undefined,
  threadId: string,
  comment: ReviewComment | null,
  headSha?: string
): Verdict['subject'] {
  return {
    ...(pr !== undefined ? { pr } : {}),
    threadId,
    ...(headSha !== undefined ? { headSha } : {}),
    ...(comment !== null ? { commentSha: commentKey(comment) } : {}),
  }
}

/** Append one journal row — plain append is atomic at this size; a
 *  missing journal dir is created on first write. No-op outside a
 *  repo (a consumer without a git dir simply has no shadow log). */
export function appendRow(dir: string, row: JournalRow): void {
  const path = journalPath(dir)
  if (path === null) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(row)}\n`)
}

/** The whole journal, malformed lines dropped — a torn last line from
 *  a killed writer must not poison the read. */
export function readJournal(dir: string): JournalRow[] {
  const path = journalPath(dir)
  if (path === null) {
    return []
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const rows: JournalRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      const row = JSON.parse(line) as JournalRow
      // subject must be an OBJECT (possibly {}) — a torn-but-valid tail
      // like {"kind":"x"} or "subject":"s" makes findVerdict's
      // r.subject.threadId throw; threadId itself is legitimately
      // absent on judge-decide rows
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof row.kind === 'string' &&
        typeof row.subject === 'object' &&
        row.subject !== null
      ) {
        rows.push(row)
      }
    } catch {
      // torn write — skip
    }
  }
  return rows
}

const isVerdict = (r: JournalRow): r is Verdict => r.kind !== 'act-disposition'

/** Call-site dedup: the latest verdict for this subject, or undefined
 *  when the inputs moved. Every field the caller supplies must equal —
 *  a new commentSha or headSha is a moved subject and earns a fresh
 *  decide() (spec: cost dedup happens at the call site, not in the
 *  journal). Replay rows are training data, not live answers — never
 *  served back to a caller. */
export function findVerdict(
  rows: JournalRow[],
  subject: { threadId: string; commentSha?: string; headSha?: string }
): Verdict | undefined {
  const match = (r: JournalRow): r is Verdict =>
    isVerdict(r) &&
    r.replay !== true &&
    r.subject.threadId === subject.threadId &&
    (subject.commentSha === undefined || r.subject.commentSha === subject.commentSha) &&
    (subject.headSha === undefined || r.subject.headSha === subject.headSha)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!
    if (match(r)) {
      return r
    }
  }
  return undefined
}

/** Record what actually happened to a thread — the outcome half of the
 *  agreement metric, appended where the disposition happens (`bro act
 *  resolve/reply/defer`). The commentSha join key is recovered from the
 *  latest verdict for the thread when the caller never saw the comment
 *  (a bare `act resolve --thread` doesn't fetch it). */
export function recordDisposition(
  dir: string,
  subject: { pr?: number; threadId: string; commentSha?: string; headSha?: string },
  outcome: Disposition['outcome']
): void {
  let { commentSha, headSha } = subject
  if (commentSha === undefined) {
    const seen = findVerdict(readJournal(dir), { threadId: subject.threadId })
    commentSha = seen?.subject.commentSha
    headSha = headSha ?? seen?.subject.headSha
  }
  appendRow(dir, {
    ts: new Date().toISOString(),
    kind: 'act-disposition',
    subject: {
      ...(subject.pr !== undefined ? { pr: subject.pr } : {}),
      threadId: subject.threadId,
      ...(headSha !== undefined ? { headSha } : {}),
      ...(commentSha !== undefined ? { commentSha } : {}),
    },
    outcome,
  })
}
