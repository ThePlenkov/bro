import { makeCopilotConnector, registerAgentConnector } from './core.ts';
registerAgentConnector('copilot', makeCopilotConnector, {}, { builtin: true });
