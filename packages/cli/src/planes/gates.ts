/** gates plane — the open-PR review gate `bro act status` evaluates,
 *  over the same reviewHost facade + fetchPrActState + evaluateExitGate
 *  (specs/bro-9rls.1.md). Rows are Gate, never "act" nouns. */
import {
  facadeAuth,
  loadConfig,
  PlaneUnavailable,
  PlaneVerbError,
  reviewHost,
  verbsNotWired,
  type Gate,
  type PlaneCtx,
  type PlaneDescriptor,
  type PrTarget,
  type ReviewFacade,
} from '@broject/core'
import { checkHistory, evaluateExitGate, fetchPrActState, type ExitGate, type PrActState } from '@broject/act'
import { argBool, argNumber, dispatchRead, inRepo } from './helpers.ts'

const VERBS = ['resolve', 'reply', 'merge']

/** resolvePr's plane twin — an explicit number or the current branch's
 *  OPEN PR; `null` when the branch has none (absence, not an error). */
function resolveTarget(rev: ReviewFacade, args?: Record<string, unknown>): PrTarget | null {
  const repo = rev.resolveRepo([])
  const raw = args?.pr ?? args?.ref
  if (raw === undefined) {
    const cur = rev.currentPr()
    return cur !== null && cur.state === 'OPEN' ? { repo, pr: cur.pr } : null
  }
  const pr = typeof raw === 'number' ? raw : Number(argNumber({ pr: raw }, 'pr') ?? Number.NaN)
  if (!Number.isInteger(pr) || pr <= 0) {
    const shown = typeof raw === 'string' ? raw : JSON.stringify(raw)
    throw new PlaneVerbError('gates', 'get', `invalid pr "${shown}"`)
  }
  return { repo, pr }
}

async function stateOf(ctx: PlaneCtx, rev: ReviewFacade, t: PrTarget): Promise<{
  state: PrActState
  gate: ExitGate
}> {
  const act = loadConfig(ctx.dir).act
  const state = await fetchPrActState(rev, t, {
    ignoreChecks: act.ignoreChecks,
    checkHistory: checkHistory(ctx.dir),
    maxRounds: act.maxRounds,
    docsPaths: act.docsPaths,
    docsMaxRounds: act.docsMaxRounds,
  })
  return { state, gate: evaluateExitGate(state) }
}

const gateRow = (state: PrActState, gate: ExitGate): Gate => ({
  id: String(state.pr),
  pr: state.pr,
  url: state.url,
  headRef: state.headRef,
  state: gate.ok ? 'GREEN' : 'BLOCKED',
  openThreads: gate.open_threads,
  ciPending: gate.ci_pending,
  ciFailing: gate.ci_failing,
  reviewersPending: gate.reviewers_pending,
  sastPending: gate.sast_pending,
  blockers: gate.blockers,
  alerts: gate.alerts,
})

export function gatesPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  /** null = no review host serves this repo — honest absence */
  const host = (): ReviewFacade | null => {
    try {
      return reviewHost(dir, ctx.connectors)
    } catch {
      return null
    }
  }
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro act status --json` — full state + the exit gate, or null
     *  when no open PR resolves (absence, not an error). */
    status: async (a) => {
      const rev = host()
      if (rev === null) {
        throw new PlaneUnavailable('gates', 'no review connector serves this repo')
      }
      const t = resolveTarget(rev, a)
      if (t === null) {
        return null
      }
      const { state, gate } = await stateOf(ctx, rev, t)
      return { pr: state, gate }
    },
    /** `bro act threads` — unresolved threads by default; `all: true`
     *  includes resolved/outdated for archaeology. */
    threads: async (a) => {
      const rev = host()
      if (rev === null) {
        throw new PlaneUnavailable('gates', 'no review connector serves this repo')
      }
      const t = resolveTarget(rev, a)
      if (t === null) {
        return null
      }
      const threads = await rev.reviewThreads(t)
      return argBool(a, 'all') === true ? threads : threads.filter((th) => !th.resolved)
    },
  }
  return {
    name: 'gates',
    reads: Object.keys(reads),
    verbs: VERBS,
    readArgs: {
      list: { type: 'object', properties: {} },
      status: {
        type: 'object',
        properties: { pr: { type: 'integer', description: 'PR number; default: current branch\'s open PR' } },
      },
      threads: {
        type: 'object',
        properties: {
          pr: { type: 'integer', description: 'PR number; default: current branch\'s open PR' },
          all: { type: 'boolean', description: 'include resolved/outdated threads' },
        },
      },
    },
    capabilities: async () => ({
      // facadeAuth, not facadeName — connector selection alone proves
      // nothing about auth; an unauthenticated backend has no tools
      read: inRepo(dir) && facadeAuth('reviews', { dir }, { prefer: ctx.connectors }) === null,
      resolve: false,
      reply: false,
      merge: false,
    }),
    list: async () => {
      const rev = host()
      if (rev === null) {
        throw new PlaneUnavailable('gates', 'no review connector serves this repo')
      }
      const t = resolveTarget(rev)
      if (t === null) {
        return []
      }
      const { state, gate } = await stateOf(ctx, rev, t)
      return [gateRow(state, gate)]
    },
    get: async (ref) => {
      const rev = host()
      if (rev === null) {
        throw new PlaneUnavailable('gates', 'no review connector serves this repo')
      }
      const t = resolveTarget(rev, { pr: ref })
      if (t === null) {
        return undefined
      }
      const { state, gate } = await stateOf(ctx, rev, t)
      return gateRow(state, gate)
    },
    read: (name, args) => dispatchRead('gates', reads, name, args),
    exec: verbsNotWired('gates', VERBS),
  }
}
