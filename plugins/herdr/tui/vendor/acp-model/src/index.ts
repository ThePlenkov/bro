// Public API of `acp-model`: the sanitiser, the session model types and the reducer.
//
// This package is framework-free (design D2): no Solid, OpenTUI or Paseo imports, and no runtime
// import of `@agentclientprotocol/sdk` (its types are used only as `import type`). See
// test/import-graph.test.ts, which asserts this mechanically by walking this package's own
// source imports.

// Retained so the acp-tui and fake-agent placeholder entry points (Phase 0 workspace scaffold)
// keep typechecking until those packages' own tasks replace them; not part of the model's real
// API surface described below.
export const ACP_MODEL_PACKAGE_NAME = "acp-model" as const;

export { sanitise } from "./sanitiser.ts";
export type { SanitiseMode } from "./sanitiser.ts";

export { reduce } from "./reducer.ts";

export { createSession } from "./types.ts";
export type {
  AgentCommand,
  AgentInfo,
  AgentMessageItem,
  ConnectionState,
  InvalidModelsDebugInfo,
  Item,
  ItemOrigin,
  ItemStatus,
  LegacyModelInfo,
  LegacyModelState,
  MarkerItem,
  ModelDebugInfo,
  ModelEvent,
  PermissionOutcome,
  PermissionRecordItem,
  PlanItem,
  Session,
  SessionOpenMode,
  TextItemKind,
  ThoughtItem,
  ToolCallItem,
  ToolCallItemContent,
  TurnState,
  UnknownModeDebugInfo,
  UnknownModelDebugInfo,
  UnknownUpdateDebugInfo,
  UserMessageItem,
} from "./types.ts";
