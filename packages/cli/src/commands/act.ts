/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
 *   threads [PR]           unresolved review threads, TSV
 *   resolve --thread ID [--comment TEXT] [--unresolve]
 *   reply   --thread ID --comment TEXT | --file TSV
 */
import { readFileSync } from 'node:fs'
import { ensureGhAuth, gh, ghJson, resolveRepo } from '@bro/core'
import {
  evaluateExitGate,
  fetchPrActState,
  replyToThread,
  resolveReviewThread,
  unresolveReviewThread,
} from '@bro/act'

function usage(): never {
  console.error(`Usage: bro act <command> [args…]

Commands:
  status [PR] [--json]              PR state + exit gate JSON
  threads [PR]                      Unresolved review threads (TSV)
  resolve --thread ID [--comment T] Resolve thread, optionally reply first
  reply --thread ID --comment T     Reply without resolving
        --file TSV                  Batch reply: <thread_id>\t<body> per line
        --unresolve                 resolve → unresolve instead`)
  process.exit(1)
}

const VALUE_FLAGS = new Set(['--pr', '--thread', '--comment', '--file'])

/** PR number: --pr flag, first positional, or the current branch's PR. */
function resolvePr(argv: string[]): { repo: string; owner: string; repoName: string; pr: number } {
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) {
        i += 1
      }
      continue
    }
    positional.push(arg)
  }
  const prFlag = argv.indexOf('--pr')
  const prRaw =
    (prFlag >= 0 ? argv[prFlag + 1] : undefined) ?? positional[0] ?? null

  const repo = resolveRepo([])
  const [owner, repoName] = repo.split('/')

  if (prRaw === null) {
    // `gh pr view` resolves the PR for the CURRENT branch — `gh pr list
    // --limit 1` would grab an arbitrary open PR instead. It also resolves
    // CLOSED/MERGED PRs, so state must be checked explicitly.
    let pr: { number: number; state: string } | null = null
    try {
      pr = JSON.parse(gh(['pr', 'view', '--json', 'number,state']))
    } catch {
      /* no PR for this branch */
    }
    if (!pr || pr.state !== 'OPEN') {
      console.error('error: no open PR for current branch — pass a PR number')
      process.exit(2)
    }
    return { repo, owner: owner!, repoName: repoName!, pr: pr.number }
  }
  const pr = Number(prRaw)
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`error: invalid PR number "${prRaw}"`)
    process.exit(2)
  }
  return { repo, owner: owner!, repoName: repoName!, pr }
}

async function cmdStatus(argv: string[]): Promise<void> {
  ensureGhAuth()
  const json = argv.includes('--json')
  const t = resolvePr(argv)
  const state = await fetchPrActState({ owner: t.owner, repo: t.repoName, pr: t.pr })
  const gate = evaluateExitGate(state)

  if (!gate.ok) {
    process.exitCode = 1
  }
  if (json) {
    console.log(JSON.stringify({ pr: state, exit_gate: gate }, null, 2))
    return
  }
  console.log(`pr=#${state.pr} ${state.headRef} ${state.url}`)
  console.log(`mergeable=${state.mergeable} merge_state=${state.mergeState} draft=${state.isDraft}`)
  console.log(
    `open_threads=${gate.open_threads} ci_pending=${gate.ci_pending} ` +
      `reviewers_pending=${gate.reviewers_pending} ` +
      `sast_pending=${gate.sast_pending} sast_unknown=${gate.sast_unknown}`
  )
  console.log(`exit_gate=${gate.ok ? 'OK' : 'BLOCKED'}`)
  for (const b of gate.blockers) {
    console.log(`  blocker: ${b}`)
  }
}

async function cmdThreads(argv: string[]): Promise<void> {
  ensureGhAuth()
  const t = resolvePr(argv)
  const state = await fetchPrActState({ owner: t.owner, repo: t.repoName, pr: t.pr })
  for (const thread of state.threads) {
    if (thread.isResolved) {
      continue
    }
    const c = thread.comments.nodes[0]
    const author = c?.author?.login ?? '-'
    const path = c?.path ?? '-'
    const line = c?.line ?? '-'
    const body = (c?.body ?? '').replace(/[\n\t]/g, ' ').slice(0, 120)
    console.log(`${thread.id}\t${author}\t${path}:${line}\t${body}`)
  }
  console.error(`act threads: ${state.openThreads} unresolved`)
}

function threadArg(argv: string[]): string {
  const i = argv.indexOf('--thread')
  const id = i >= 0 ? argv[i + 1] : undefined
  if (!id) {
    console.error('error: --thread required')
    usage()
  }
  return id!
}

function commentArg(argv: string[]): string | null {
  const i = argv.indexOf('--comment')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/** Resolving your own PR's threads is self-grading — a human/reviewer does it. */
function guardOwnPr(argv: string[]): void {
  const t = resolvePr(argv)
  const author = ghJson<{ author?: { login?: string } }>([
    'pr', 'view', String(t.pr), '--repo', t.repo, '--json', 'author',
  ]).author?.login
  const me = ghJson<{ login?: string }>(['api', 'user']).login
  if (author && me && author === me) {
    console.error(
      `error: PR #${t.pr} is authored by ${me} — cannot resolve/reply on your own PR; a reviewer must close the threads`
    )
    process.exit(2)
  }
}

function cmdResolve(argv: string[]): void {
  ensureGhAuth()
  guardOwnPr(argv)
  const id = threadArg(argv)
  const comment = commentArg(argv)
  const unresolve = argv.includes('--unresolve')
  if (comment) {
    replyToThread(id, comment)
    console.error(`act: replied on ${id}`)
  }
  if (unresolve) {
    unresolveReviewThread(id)
    console.error(`act: unresolved ${id}`)
  } else {
    resolveReviewThread(id)
    console.error(`act: resolved ${id}`)
  }
}

function cmdReply(argv: string[]): void {
  ensureGhAuth()
  guardOwnPr(argv)
  const fileIdx = argv.indexOf('--file')
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1]
    if (!file) {
      console.error('error: --file requires a path')
      process.exit(2)
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    let skipped = 0
    const rows = lines
      .map((l) => {
        const tab = l.indexOf('\t')
        if (tab === -1) {
          skipped += 1
          return null
        }
        return {
          id: l.slice(0, tab).trim(),
          body: l.slice(tab + 1).replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\t`, '\t'),
        }
      })
      .filter((r): r is { id: string; body: string } => r !== null)
    for (const row of rows) {
      replyToThread(row.id, row.body)
      console.error(`act: replied on ${row.id}`)
    }
    console.error(`act reply: ${rows.length} repl(ies)`)
    if (skipped > 0) {
      console.error(`warning: ${skipped} line(s) had no <thread_id><TAB><body> shape — skipped`)
      process.exitCode = 1
    }
    return
  }
  const id = threadArg(argv)
  const comment = commentArg(argv)
  if (!comment) {
    console.error('error: --comment required (or --file TSV)')
    usage()
  }
  replyToThread(id, comment!)
  console.error(`act: replied on ${id}`)
}

const COMMANDS: Record<string, (argv: string[]) => void | Promise<void>> = {
  status: cmdStatus,
  threads: cmdThreads,
  resolve: cmdResolve,
  reply: cmdReply,
}

export async function runActCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage()
  }
  const handler = COMMANDS[cmd!]
  if (!handler) {
    console.error(`unknown command: ${cmd}`)
    usage()
  }
  await handler(rest)
}
