import { registerAgentConnector } from './core.ts'
import { makeGascityConnector, gcMatchDir } from './core.ts'
registerAgentConnector('gascity', makeGascityConnector, { matchDir: gcMatchDir }, { builtin: true })
