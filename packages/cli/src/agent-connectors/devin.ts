import { makeDevinConnector, registerAgentConnector } from './core.ts';
registerAgentConnector('devin', makeDevinConnector, {}, { builtin: true });
