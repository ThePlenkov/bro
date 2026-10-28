import { registerAgentConnector } from './core.ts'
import { makeDockerConnector } from './core.ts'
registerAgentConnector('docker', makeDockerConnector, {}, { builtin: true })
