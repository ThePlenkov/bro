/** The entry script this process was launched as, absolutized at module
 *  load. Every detached respawn (pulse rearm, daemon, act-wait rearm,
 *  post-merge worker) re-roots its child at a foreign cwd — a relative
 *  `process.argv[1]` (`node ./dist/index.js`, dev invocations) would
 *  resolve against the CHILD's cwd there and the rearm never finds the
 *  CLI. Resolving at load also beats the hook process's own
 *  `enterHookProject` chdir, which runs before any connector probe gets
 *  to spawn. Null when argv is not bro-shaped (tests import these
 *  modules directly). */
import { resolve } from 'node:path'

export const SELF_ENTRY: string | null =
  process.argv[1] === undefined ? null : resolve(process.argv[1])
