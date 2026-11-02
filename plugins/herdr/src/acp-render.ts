// Re-export shim — the byte-identical vendored copy is gone; the
// implementation lives in @broject/acp-session (packages/acp/session/
// src/wire). Source-level re-export because the plugin sits outside
// npm workspaces — no bare specifier is available here.
export * from '../../../packages/acp/session/src/index.ts';
