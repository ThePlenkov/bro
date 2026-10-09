/**
 * External merge-queue connectors (spec specs/bro-huy5o.6.md) — the
 * `mergeQueue` facade for teams whose queue lives outside GitHub's
 * native one. Both are `optIn` and provide nothing else, so only a
 * `connectors.mergeQueue` pin ever resolves them.
 *
 * - mergify: signal Mergify through the PR itself — a queue label
 *   (`act.mergeQueue.label`) and/or a queue command comment
 *   (`act.mergeQueue.comment`, default `@mergifyio queue`). Mergify's
 *   own rules decide what the signal means; bro never authors them.
 * - graphite: `gt merge` in the PR's checkout — it merges the stack the
 *   checkout sits on, so the headRef must match the checked-out branch.
 */
import { spawnSync } from 'node:child_process'
import {
  gh,
  ghJson,
  ghTry,
  gitTry,
  loadConfig,
  prLink,
  type Connector,
  type MergeQueueFacade,
  type PrTarget,
} from '@broject/core'

/** `gt` without the throw — the auth probe's shape. PATH lookup is the
 *  contract (same as gh/glab). */
function gtTry(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const proc = spawnSync('gt', args, { // NOSONAR — user-installed CLI
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return { code: proc.status ?? 1, out: proc.stdout ?? '', err: (proc.stderr ?? '').trim() }
}

/** The PR's current state — enqueue's post-call answer comes from the
 *  host, never from the tool's own output. */
function stateOf(t: PrTarget, dir: string): string {
  const view = ghJson<{ state?: string }>(
    ['pr', 'view', String(t.pr), '--repo', t.repo, '--json', 'state'],
    dir
  )
  return (view.state ?? 'UNKNOWN').toUpperCase()
}

/** Is an identical queue command already on the PR? Enqueue must be
 *  idempotent — a drive pass re-attempts every parked PR, and without
 *  this each interval posts another command comment. Failing the scan
 *  posts anyway: a duplicate is noise, a missed enqueue is a lost queue. */
function queueCommented(t: PrTarget, body: string, dir: string): boolean {
  const res = ghTry(['pr', 'view', String(t.pr), '--repo', t.repo, '--json', 'comments'], dir)
  if (res.code !== 0) {
    return false
  }
  try {
    const view = JSON.parse(res.out) as { comments?: Array<{ body?: string }> }
    return (view.comments ?? []).some((c) => c.body === body)
  } catch {
    return false
  }
}

/** Mergify: park the PR by signaling it — the label a queue rule
 *  watches for, and/or the command comment. The state probe runs first:
 *  a PR Mergify already landed (or closed between gate and enqueue)
 *  must never get a queue signal. */
export function mergifyQueue(dir: string): MergeQueueFacade {
  return {
    enqueue(t, opts) {
      const cwd = opts?.dir ?? dir
      const before = stateOf(t, cwd)
      if (before === 'MERGED') {
        return 'merged'
      }
      if (before !== 'OPEN') {
        throw new Error(`${prLink(t.repo, t.pr)} is ${before} — nothing to enqueue`)
      }
      const cfg = loadConfig(cwd).act.mergeQueue
      // label first — a label-triggered rule needs it present before the
      // command comment lands, not after
      if (cfg.label !== undefined) {
        gh(['pr', 'edit', String(t.pr), '--repo', t.repo, '--add-label', cfg.label], cwd)
      }
      // a label alone can carry the signal (rule queues on it); with no
      // label the command comment is the zero-config default
      const command = cfg.comment ?? (cfg.label === undefined ? '@mergifyio queue' : undefined)
      if (command !== undefined && !queueCommented(t, command, cwd)) {
        gh(['pr', 'comment', String(t.pr), '--repo', t.repo, '--body', command], cwd)
      }
      return 'enqueued'
    },
  }
}

/** Graphite: `gt merge` merges the stack the checkout sits on — the
 *  headRef check is the only thing standing between "queue this PR" and
 *  "queue whatever stack this directory happens to hold". The honest
 *  post-state read distinguishes landed-outright (a queue-less repo
 *  merges directly) from parked. */
export function graphiteQueue(dir: string): MergeQueueFacade {
  return {
    enqueue(t, opts) {
      const cwd = opts?.dir ?? dir
      if (opts?.headRef !== undefined) {
        const on = gitTry(['-C', cwd, 'branch', '--show-current'])
        if (on.code !== 0 || on.out.trim() !== opts.headRef) {
          throw new Error(
            `graphite: ${cwd} is on '${on.out.trim() || 'detached'}', ` +
              `expected the PR head '${opts.headRef}' — \`gt merge\` would queue the wrong stack`
          )
        }
      }
      const proc = spawnSync('gt', ['merge'], { // NOSONAR — user-installed CLI
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
      if (proc.status !== 0) {
        throw new Error(`gt merge failed: ${(proc.stderr ?? proc.error?.message ?? '').trim()}`)
      }
      const out = (proc.stdout ?? '').trim()
      if (out !== '') {
        console.log(out)
      }
      const after = stateOf(t, cwd)
      if (after === 'MERGED') {
        return 'merged'
      }
      if (after !== 'OPEN') {
        throw new Error(`${prLink(t.repo, t.pr)} is ${after} after \`gt merge\` — nothing to enqueue`)
      }
      return 'enqueued'
    },
  }
}

export const mergifyConnector: Connector = {
  name: 'mergify',
  /** Queue connectors are name-only (spec specs/bro-huy5o.6.md) — a
   *  repo's remote says github, not who queues its merges. Pin it:
   *  `"connectors": {"mergeQueue": "mergify"}`. */
  optIn: true,
  auth: () =>
    ghTry(['auth', 'status']).code === 0
      ? null
      : 'gh not authenticated — run `gh auth login`',
  mergeQueue: (ctx) => mergifyQueue(ctx.dir),
}

export const graphiteConnector: Connector = {
  name: 'graphite',
  optIn: true,
  /** `gt` on PATH is the gate — enqueue's post-state read rides `gh`,
   *  whose own auth the reviews facade already gates. */
  auth: () =>
    gtTry(['--version']).code === 0
      ? null
      : 'gt not installed — install the Graphite CLI (`npm i -g @withgraphite/graphite-cli`)',
  mergeQueue: (ctx) => graphiteQueue(ctx.dir),
}
