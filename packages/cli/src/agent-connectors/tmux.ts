import { registerAgentConnector } from './core.ts'
import { makeTmuxConnector } from './core.ts'
registerAgentConnector('tmux', makeTmuxConnector, {}, { builtin: true })
