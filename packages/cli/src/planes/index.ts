/** Plane registration — importing this module makes the built-in
 *  catalog visible to `planes(dir)` in core. Spec order is canonical
 *  (work → debt); `learn` is the eighth plane the MCP bead declares
 *  (specs/bro-9rls.1.md + bro-9rls.2). */
import { registerPlane } from '@broject/core'
import { agentsPlane } from './agents.ts'
import { debtPlane } from './debt.ts'
import { eventsPlane } from './events.ts'
import { gatesPlane } from './gates.ts'
import { judgePlane } from './judge.ts'
import { learnPlane } from './learn.ts'
import { queuePlane } from './queue.ts'
import { workPlane } from './work.ts'

registerPlane('work', workPlane)
registerPlane('agents', agentsPlane)
registerPlane('queue', queuePlane)
registerPlane('gates', gatesPlane)
registerPlane('events', eventsPlane)
registerPlane('judge', judgePlane)
registerPlane('debt', debtPlane)
registerPlane('learn', learnPlane)
