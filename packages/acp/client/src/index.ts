// @broject/acp-client — the ACP client half: one persistent session
// over stdio, with the prompt QUEUE the protocol does not have.
//
// The client speaks ACP and nothing else: no agent's name appears in
// its code, the command is a parameter. What it adds over the bare
// protocol is the session's LIFECYCLE — one prompt at a time, the
// rest queued and visible, cancel for the running turn, and
// permission asks the human answers (never auto-approved).

export {
  AcpClient,
  type AcpClientOptions,
  type AgentCapabilities,
  type ClientRow,
  type ClientState,
  type PermissionAsk,
  type PermissionOption,
  type PermissionRequestLike,
  type PermissionVerdict,
  PROTOCOL_VERSION,
  type QueuedPrompt,
  type RpcMessage,
  type SessionUpdateLike,
} from './client.ts';

export { splitArgv, splitArgvDetailed } from './argv.ts';
