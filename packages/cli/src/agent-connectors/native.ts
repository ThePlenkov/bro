import { registerAgentConnector } from './core.ts'
import { makeNativeConnector } from './core.ts'
registerAgentConnector('native', makeNativeConnector, {}, { builtin: true })
