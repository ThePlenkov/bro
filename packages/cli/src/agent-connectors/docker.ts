import { makeDockerConnector, registerAgentConnector } from './core.ts';
registerAgentConnector('docker', makeDockerConnector, {}, { builtin: true });
