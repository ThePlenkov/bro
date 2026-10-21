/** `bro rig next` — the adapter over @broject/rig's re-entry verb
 *  (specs bro-oy3k1.1 §engine, bro-oy3k1.5; extraction bro-jamp7). The
 *  engine recomputes from durable state — beads claims, the agent
 *  registry, worktrees, the forge; this file owns argv → verdict →
 *  stdout → exit code and nothing else. */
import { rigNext, type RigNext } from '@broject/rig'

/** One line of human output — `rig next: step bro-abc — own claim`. */
function render(n: RigNext): string {
  const id = n.id === undefined ? '' : ` ${n.id}`
  const detail = n.detail === undefined ? '' : ` — ${n.detail}`
  return `rig next: ${n.verdict}${id}${detail}`
}

/** The `rig next` sub — a pure read over durable state, no repo-sync
 *  resolution (rig-pulse's `--repo` contract doesn't apply). Exits 1
 *  only on `blocked`. */
export function runRigNext(cwd: string, item: string | undefined, json: boolean): never {
  const n = rigNext(cwd, item)
  console.log(json ? JSON.stringify(n) : render(n))
  return process.exit(n.verdict === 'blocked' ? 1 : 0)
}
