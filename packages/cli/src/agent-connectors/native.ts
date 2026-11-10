import { makeNativeConnector, registerAgentConnector } from './core.ts';
registerAgentConnector('native', makeNativeConnector, {}, { builtin: true });
