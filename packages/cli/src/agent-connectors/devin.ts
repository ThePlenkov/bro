import { registerAgentConnector } from './core.ts'
import { makeDevinConnector } from './core.ts'
registerAgentConnector('devin', makeDevinConnector, {}, { builtin: true })
