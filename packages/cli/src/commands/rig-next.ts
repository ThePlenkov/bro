import {
  bdJson,
  getConnector,
  resolveRepo,
  type BeadStore,
  type BroContext,
  type IssuesConnector,
  type RigContext,
  type ReviewsConnector,
  type TasksConnector,
} from '@broject/core'
import { rigNext } from '@broject/rig'

export async function runRigNext(opts: {
  json?: boolean
  cwd?: string
  dir?: string
  store?: BeadStore
} = {}): Promise<number> {
  const cwd = opts.dir ?? opts.cwd ?? process.cwd()
  const ctx: BroContext = { cwd }
  const repo = await resolveRepo(ctx)
  const tasks = getConnector<TasksConnector>('tasks')
  const issues = getConnector<IssuesConnector>('issues')
  const reviews = getConnector<ReviewsConnector>('reviews')
  const rig: RigContext = { repo }
  const rctx = { repo, cwd }
  const verdict = await rigNext({ repo: rctx, tasks, issues, reviews, store: opts.store })
  if (opts.json) {
    console.log(JSON.stringify(verdict, null, 2))
    return exitCode(verdict)
  }
  // keep byte-identical to the pre-extraction CLI output
  console.log(formatVerdict(verdict))
  return exitCode(verdict)
}

function formatVerdict(v: Awaited<ReturnType<typeof rigNext>>): string {
  if (v.kind === 'step') {
    const bead = v.bead.id
    const slug = v.bead.slug
    const title = v.bead.title
    const gate = v.gate ? ` [${v.gate}]` : ''
    return `step ${bead} ${slug} ${title}${gate}`
  }
  if (v.kind === 'block') {
    const bead = v.bead.id
    const slug = v.bead.slug
    const title = v.bead.title
    const gate = v.gate ? ` [${v.gate}]` : ''
    return `block ${bead} ${slug} ${title}${gate}`
  }
  if (v.kind === 'wait') {
    const bead = v.bead.id
    const slug = v.bead.slug
    const title = v.bead.title
    const gate = v.gate ? ` [${v.gate}]` : ''
    return `wait ${bead} ${slug} ${title}${gate}`
  }
  if (v.kind === 'done') {
    return `done ${v.reason}`
  }
  if (v.kind === 'idle') {
    return 'idle'
  }
  return `unknown`
}

function exitCode(v: Awaited<ReturnType<typeof rigNext>>): number {
  if (v.kind === 'step') return 0
  if (v.kind === 'block') return 1
  if (v.kind === 'wait') return 2
  if (v.kind === 'done') return 0
  if (v.kind === 'idle') return 0
  return 1
}
