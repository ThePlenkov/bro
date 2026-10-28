import { registerAgentConnector } from './core.ts'
import { makeCopilotConnector } from './core.ts'
registerAgentConnector('copilot', makeCopilotConnector, {}, { builtin: true })
