/**
 * Dogfood replay — re-judge archived review threads from merged PRs
 * (spec: specs/sessions/bro-f4ot.2-judge.md §CLI, milestone
 * bro-f4ot.2.5). `bro judge replay` reconstructs the decide() inputs
 * act triage would have seen, decides them on the live chain, and
 * journals each verdict with `replay: true` plus the outcome inferred
 * from the record — the agreement metric's ground truth, observed
 * after the fact. Replay rows are training data: stats scores them
 * only under `--replay`, live traffic is untouched.
 *
 * Outcome inference is first-hit-wins, per spec: an act-disposition
 * row beats a defer bead beats the anchor signal — resolved with an
 * outdated anchor reads 'fixed'. Threads with no recoverable outcome —
 * unresolved at merge, or resolved after a reply with the anchor still
 * on the diff — classify OUT: 'replied' vs 'rejected' is unrecoverable
 * from facade state and a silent guess would poison the agreement set.
 */
import { facade, JudgeUnavailable, loadConfig } from '@broject/core'
import type {
  Disposition,
  JudgeFacade,
  JournalRow,
  ReviewFacade,
  ReviewThread,
  Verdict,
} from '@broject/core'
import {
  appendRow,
  commentKey,
  readJournal,
  threadSubject,
} from './journal.ts'
import { ACT_THREAD_QUESTIONS, threadState } from './shadow.ts'

/** Everything inference needs that isn't on the thread itself —
 *  dispositions and defer refs are run-wide. */
export interface InferenceCtx {
  /** Journal's act-disposition rows. */
  dispositions: Disposition[]
  /** Bead ids are irrelevant — the set holds thread_ids carried as
   *  bead external_refs (the act defer flow's link). */
  deferRefs: Set<string>
}

/** Latest disposition for the subject. Replay's join is looser than
 *  the live stats rule on purpose: a disposition carrying a commentSha
 *  must equal the reconstructed subject's (a moved comment is a
 *  different subject), but a SHA-less disposition still joins by
 *  threadId — pre-judge act runs never saw a verdict to backfill from,
 *  and on a merged PR the thread is frozen history: that row is the
 *  only reliable replied/rejected signal the dogfood has. Later rows
 *  win. */
function dispositionFor(
  dispositions: Disposition[],
  threadId: string,
  commentSha: string | undefined
): string | undefined {
  for (let i = dispositions.length - 1; i >= 0; i -= 1) {
    const d = dispositions[i]!
    if (d.subject.threadId !== threadId) {
      continue
    }
    if (
      commentSha !== undefined &&
      d.subject.commentSha !== undefined &&
      d.subject.commentSha !== commentSha
    ) {
      continue
    }
    return d.outcome
  }
  return undefined
}

/** The outcome half of the dogfood pair. Order: the recorded
 *  disposition wins; an explicit defer bead outranks thread state —
 *  the bead is the record of the defer, a reopened or resolve-dropped
 *  thread doesn't undo it; resolved with an outdated anchor — the
 *  flagged lines left the diff — reads 'fixed'. A push alone is not
 *  evidence: a commit stamped after the comment may be unrelated to
 *  the finding, so resolved with the anchor still on the diff is
 *  unrecoverable — replied/rejected look identical on the facade, and
 *  a wrong 'fixed' poisons the agreement set worse than a smaller
 *  sample does. */
export function inferOutcome(
  thread: ReviewThread,
  ctx: InferenceCtx
): string | undefined {
  const commentSha = thread.comment !== null ? commentKey(thread.comment) : undefined
  const recorded = dispositionFor(ctx.dispositions, thread.id, commentSha)
  if (recorded !== undefined) {
    return recorded
  }
  if (ctx.deferRefs.has(thread.id)) {
    return 'deferred'
  }
  if (!thread.resolved) {
    return undefined // unresolved when the PR settled → excluded
  }
  if (thread.outdated) {
    return 'fixed' // the diff moved past the finding — a later headSha
  }
  return undefined
}

export interface ReplayOpts {
  /** Working dir — locates the shared journal + the defer beads. */
  dir: string
  /** 'owner/name' the merged PRs live under. */
  repo: string
  /** Resolved facades — tests inject fakes. */
  rev: ReviewFacade
  judge: JudgeFacade
  /** Explicit PR selection — wins over the merged-since scan. */
  prs?: number[]
  /** Only PRs merged at/after this ISO timestamp enter the scan. */
  mergedSince?: string
  /** Merged-PR listing cap for the scan path (default 50). */
  limit?: number
  /** Fresh decide() attempts this run may pay for — defaults to
   *  judge.maxDecisionsPerRun's caller-side equivalent (50). */
  budget?: number
  /** Defer-bead thread refs — injectable; the default reads the repo's
   *  'debt'-labelled beads once per run. */
  deferRefs?: Set<string>
  /** Progress line sink — the CLI wires it to stderr. */
  onProgress?: (msg: string) => void
}

export interface ReplayResult {
  /** Merged PRs scanned. */
  prs: number
  /** Threads seen across them. */
  threads: number
  /** Threads with a classifiable outcome — the decidable set. */
  candidates: number
  /** Fresh verdicts journaled this run. */
  judged: number
  /** Candidates that already carried a replay verdict — re-run reads. */
  cached: number
  /** Threads dropped as unclassifiable — smaller sample over a wrong
   *  one, per spec. */
  excluded: number
  /** decide() failures (attempts still consumed budget). */
  failed: number
  /** Candidates dropped because the decision budget ran out — the
   *  truncation signal: another run finishes them. */
  skipped: number
}

const REPLAY_CONCURRENCY = 4
const DEFAULT_SCAN_LIMIT = 50

/** The dedup key for replay rows — a replay verdict never serves live
 *  callers (findVerdict skips them), so a re-run must dedup against
 *  the replay set itself. */
const replayKey = (v: Verdict): string | undefined =>
  v.subject.threadId === undefined
    ? undefined
    : `${v.subject.threadId} ${v.subject.commentSha ?? ''}`

const isVerdict = (r: JournalRow): r is Verdict => r.kind !== 'act-disposition'

type PrKey = { repo: string; pr: number }
type ThreadMap = Map<number, ReviewThread[]>

/** The connector's bulk scan — covers the target set it returns; a
 *  connector-level failure degrades to the serial probe. */
async function bulkScan(
  opts: ReplayOpts,
  targets: PrKey[],
  missing: Set<number>,
  out: ThreadMap
): Promise<void> {
  if (typeof opts.rev.scanMergedPrs !== 'function' || targets.length === 0) {
    return
  }
  try {
    const scans = await opts.rev.scanMergedPrs(targets, {
      onProgress: (done, total) =>
        opts.onProgress?.(`judge replay: probed ${done}/${total} merged PR(s)`),
    })
    for (const [pr, scan] of scans) {
      out.set(pr, scan.threads)
      missing.delete(pr)
    }
  } catch (err) {
    console.error(
      `warning: bulk scan failed — falling back to serial probes ` +
        `(${err instanceof Error ? err.message : err})`
    )
  }
}

/** Serial per-PR fetch for whatever the bulk pass missed. */
async function serialProbe(
  opts: ReplayOpts,
  targets: PrKey[],
  missing: Set<number>,
  out: ThreadMap
): Promise<void> {
  for (const t of targets) {
    if (!missing.has(t.pr)) {
      continue
    }
    try {
      out.set(t.pr, await opts.rev.reviewThreads(t))
    } catch (err) {
      console.error(
        `warning: thread fetch for #${t.pr} failed — ` +
          `${err instanceof Error ? err.message : err}`
      )
    }
  }
}

/** Threads for the selected PRs — the connector's bulk scan when it
 *  exists, the serial per-PR fetch for what the bulk pass missed. */
async function probeThreads(
  opts: ReplayOpts,
  targets: PrKey[]
): Promise<ThreadMap> {
  const out: ThreadMap = new Map()
  const missing = new Set(targets.map((t) => t.pr))
  await bulkScan(opts, targets, missing, out)
  await serialProbe(opts, targets, missing, out)
  return out
}

/** Default defer-ref set — thread_ids carried as external_ref on
 *  'debt'-labelled beads (the act defer flow's link). Read once per
 *  run; the store scan is one bd call. A dir with no beads store has
 *  no defer beads by definition — the set is empty, not an error; a
 *  real store failure warns and degrades (the defer signal is one of
 *  three, and dispositions usually cover act-driven defers). */
function loadDeferRefs(dir: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const row of facade('tasks', { dir }, { prefer: loadConfig(dir).connectors }).list({
      all: true,
      labels: ['debt'],
      limit: 0,
    })) {
      if (typeof row.external_ref === 'string' && row.external_ref !== '') {
        out.add(row.external_ref)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/no beads database/i.test(msg)) {
      console.error(`warning: defer-bead scan failed — ${msg}`)
    }
  }
  return out
}

type PendingItem = {
  thread: ReviewThread
  subject: Verdict['subject']
  outcome: string
}

/** Merged-PR selection — explicit ids, or the connector's merged scan
 *  capped at --limit, narrowed by --merged-since. The since stamp goes
 *  into the host query, not just the result filter: hosts cap by
 *  updated_at, so post-merge updates would crowd window-eligible PRs
 *  out before the filter ever saw them. The result-side filter stays —
 *  it also narrows the explicit-ids path, which ignores the hint. */
function selectMerged(opts: ReplayOpts): ReturnType<ReviewFacade['mergedPrs']> {
  const sinceMs =
    opts.mergedSince !== undefined ? Date.parse(opts.mergedSince) : undefined
  const merged =
    opts.prs !== undefined
      ? opts.rev.mergedPrs(opts.repo, { ids: opts.prs })
      : opts.rev.mergedPrs(opts.repo, {
          limit: opts.limit ?? DEFAULT_SCAN_LIMIT,
          ...(sinceMs !== undefined && Number.isFinite(sinceMs)
            ? { mergedSince: opts.mergedSince }
            : {}),
        })
  return sinceMs !== undefined && Number.isFinite(sinceMs)
    ? merged.filter((p) => Date.parse(p.mergedAt) >= sinceMs)
    : merged
}

/** Classify one PR's threads into pending candidates — dispositions,
 *  defer refs, and the anchor signal answer the outcome question;
 *  everything unresolved by them is excluded, never guessed. */
function collectPr(
  pr: { number: number; headSha: string },
  threads: ReviewThread[],
  base: InferenceCtx,
  replayed: Set<string | undefined>,
  pending: PendingItem[],
  res: ReplayResult
): void {
  for (const thread of threads) {
    res.threads += 1
    const subject = threadSubject(pr.number, thread.id, thread.comment, pr.headSha)
    // a subject that already carries a replay verdict is cached — its
    // outcome was inferred at judgment time; re-inferring can only
    // miscount it (e.g. as excluded when a signal went missing)
    if (replayed.has(`${thread.id} ${subject.commentSha ?? ''}`)) {
      res.candidates += 1
      res.cached += 1
      continue
    }
    const outcome = inferOutcome(thread, base)
    if (outcome === undefined) {
      res.excluded += 1
      continue
    }
    res.candidates += 1
    pending.push({ thread, subject, outcome })
  }
}

/** The bounded worker pool — fresh decide() calls are capped at
 *  budget; a wedged backend ends the run, a per-thread failure skips
 *  it. Index claims are synchronous before any await — JS's
 *  run-to-completion makes the grab atomic. */
async function judgePending(
  opts: ReplayOpts,
  pending: PendingItem[],
  res: ReplayResult
): Promise<void> {
  const budget = opts.budget ?? 50
  let decided = 0
  let i = 0
  let dead = false
  const worker = async (): Promise<void> => {
    while (!dead && i < pending.length) {
      const item = pending[i]!
      i += 1
      if (decided >= budget) {
        res.skipped += 1
        continue
      }
      decided += 1 // an attempt consumes budget — it paid either way
      let decision
      try {
        decision = await opts.judge.decide(threadState(item.thread), ACT_THREAD_QUESTIONS)
      } catch (err) {
        // a dead backend ends the loop; a per-thread failure skips it
        res.failed += 1
        if (err instanceof JudgeUnavailable) {
          dead = true
        }
        continue
      }
      appendRow(opts.dir, {
        ts: new Date().toISOString(),
        kind: 'act-thread',
        subject: item.subject,
        questions: ACT_THREAD_QUESTIONS,
        answers: decision.answers,
        model: decision.model,
        latencyMs: decision.latencyMs,
        ...(decision.usage?.costUsd !== undefined
          ? { costUsd: decision.usage.costUsd }
          : {}),
        ...(decision.lowConfidence.length > 0
          ? { lowConfidence: decision.lowConfidence }
          : {}),
        outcome: item.outcome,
        replay: true,
      } satisfies Verdict)
      res.judged += 1
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REPLAY_CONCURRENCY, pending.length) }, worker)
  )
}

/** `bro judge replay` engine — select merged PRs, reconstruct the
 *  triage inputs, decide, journal replay verdicts with their inferred
 *  outcomes. Idempotent: a subject that already carries a replay
 *  verdict counts as cached, never re-judged. */
export async function replayMergedThreads(opts: ReplayOpts): Promise<ReplayResult> {
  const selected = selectMerged(opts)
  const rows = readJournal(opts.dir)
  const dispositions = rows.filter((r): r is Disposition => r.kind === 'act-disposition')
  const replayed = new Set(
    rows.filter((r) => isVerdict(r) && r.replay === true).map((v) => replayKey(v as Verdict))
  )
  const threadsByPr = await probeThreads(
    opts,
    selected.map((p) => ({ repo: opts.repo, pr: p.number }))
  )
  const base = { dispositions, deferRefs: opts.deferRefs ?? loadDeferRefs(opts.dir) }
  const res: ReplayResult = {
    prs: selected.length,
    threads: 0,
    candidates: 0,
    judged: 0,
    cached: 0,
    excluded: 0,
    failed: 0,
    skipped: 0,
  }
  const pending: PendingItem[] = []
  for (const pr of selected) {
    collectPr(pr, threadsByPr.get(pr.number) ?? [], base, replayed, pending, res)
  }
  await judgePending(opts, pending, res)
  return res
}
