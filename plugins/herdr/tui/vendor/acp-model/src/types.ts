// v2-shaped session model types (design 5.3, D2) and the internal event union the reducer
// consumes. Only `import type` is used for SDK types (task 3.1): this package holds no runtime
// dependency on the SDK, Solid, OpenTUI or Paseo, which the import-graph test in
// test/import-graph.test.ts checks mechanically.

import type {
  Implementation,
  LoadSessionResponse,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  RequestPermissionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionId,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  UsageUpdate,
} from "@agentclientprotocol/sdk";

// -- Items -------------------------------------------------------------------------------------

/** Whether an item can still change (`live`) or is committed (`final`). */
export type ItemStatus = "live" | "final";

/**
 * Where an item came from: `self` for this client's own turn, `other` for activity observed
 * while idle (another client's turn on the same session, design 5.3), `replay` for history
 * ingested by `session/load` (every item created between `session_opening` and `session_opened`,
 * plus the resume marker added at `session_opened` and the client's own notices, `client_notice`,
 * which are not activity either).
 */
export type ItemOrigin = "self" | "other" | "replay";

interface ItemBase {
  readonly id: string;
  readonly status: ItemStatus;
  readonly origin: ItemOrigin;
}

export interface UserMessageItem extends ItemBase {
  readonly kind: "user_message";
  readonly text: string;
}

export interface AgentMessageItem extends ItemBase {
  readonly kind: "agent_message";
  readonly text: string;
}

export interface ThoughtItem extends ItemBase {
  readonly kind: "thought";
  readonly text: string;
}

/** One entry of a tool call's `content` array, shaped for rendering rather than the wire. */
export type ToolCallItemContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "diff"; readonly path: string; readonly oldText: string | null; readonly newText: string }
  /** A `terminal` content block: client terminals are not supported (design 5.1), so the
   *  renderer shows "terminal output unavailable" instead of embedding anything from it. */
  | { readonly type: "terminal_unavailable" };

export interface ToolCallItem extends ItemBase {
  readonly kind: "tool_call";
  readonly toolCallId: string;
  /** Per-session index, assigned at first sighting, starting at 1, never reassigned. */
  readonly index: number;
  readonly title: string;
  readonly toolName: string | null;
  readonly toolKind: ToolKind | null;
  readonly toolStatus: ToolCallStatus;
  readonly content: readonly ToolCallItemContent[];
  readonly locations: readonly ToolCallLocation[];
  /** The latest `rawOutput` as text (a string, or the string `output` of an object, as Auggie
   *  sends it), sanitised; null when none was sent or it had another shape. */
  readonly rawOutputText: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface PlanItem extends ItemBase {
  /** Committed once, at turn end, when a plan was reported during the turn (design 6.2). */
  readonly kind: "plan";
  readonly entries: readonly PlanEntry[];
}

export type PermissionOutcome =
  | { readonly type: "pending" }
  | { readonly type: "answered"; readonly optionId: string; readonly optionKind: PermissionOptionKind }
  | { readonly type: "cancelled" }
  /** The agent withdrew the request (`$/cancel_request`) before it was answered. */
  | { readonly type: "withdrawn" };

export interface PermissionRecordItem extends ItemBase {
  readonly kind: "permission_record";
  readonly toolCallId: string;
  readonly title: string;
  readonly options: readonly PermissionOption[];
  readonly outcome: PermissionOutcome;
}

/** Turn-end marker (stop reason, duration, context used at that point), or an error/notice
 *  marker for prompt errors and agent-exit lines (task 3.1: "acp-tui must commit those"). */
export type MarkerItem =
  | {
      readonly id: string;
      readonly status: "final";
      readonly origin: ItemOrigin;
      readonly kind: "marker";
      readonly markerKind: "turn_end";
      readonly stopReason: StopReason;
      readonly durationMs: number;
      readonly usage: UsageUpdate | null;
    }
  | {
      readonly id: string;
      readonly status: "final";
      readonly origin: ItemOrigin;
      readonly kind: "marker";
      readonly markerKind: "error" | "notice";
      readonly text: string;
    };

export type Item =
  | UserMessageItem
  | AgentMessageItem
  | ThoughtItem
  | ToolCallItem
  | PlanItem
  | PermissionRecordItem
  | MarkerItem;

// -- Session -------------------------------------------------------------------------------------

export type TurnState = "idle" | "running" | "requires_action";

/** The agent's identity from the `initialize` response (`agentInfo`), sanitised on entry. */
export interface AgentInfo {
  readonly name: string;
  readonly title: string | null;
  readonly version: string | null;
}
export type ConnectionState = "connected" | "disconnected";

/** How an existing session is being opened: `session/load` replays its history, `session/resume`
 *  does not (design decision 11 of `mvp-sessions`). */
export type SessionOpenMode = "load" | "resume";

/** Internal, per-turn bookkeeping. Not part of the public rendering surface, but part of the
 *  immutable Session value so the reducer stays pure (no module-level mutable state). */
interface TurnRuntime {
  readonly startedAt: number;
  /** Tool call ids of every open permission request, in the order received. */
  readonly openPermissionToolCallIds: readonly string[];
  /** The oldest open permission request (the head of `openPermissionToolCallIds`), the one a
   *  card shows first; null when none is open. */
  readonly openPermissionToolCallId: string | null;
  /** Keys of the open elicitation requests, in the order received (the key is the caller's:
   *  `elicitation_opened` and `elicitation_closed` name the same one). */
  readonly openElicitationIds: readonly string[];
  readonly planReportedThisTurn: boolean;
}

/** One command from the agent's `available_commands_update`, sanitised. */
export interface AgentCommand {
  readonly name: string;
  readonly description: string;
  /** The input hint (`input.hint`) of a command that takes input; null for one that does not. */
  readonly inputHint: string | null;
}

/** One model of the older, unstable ACP session model state (`models` in the `session/new`,
 *  `session/load` and `session/resume` responses), sanitised. The SDK no longer types it, so
 *  this package defines it (design D1 of `session-models`). A compatibility fallback, see the
 *  technical design 5.5, **Models**. */
export interface LegacyModelInfo {
  readonly modelId: string;
  readonly name: string;
  /** The model's description; null when the agent sent none. */
  readonly description: string | null;
}

/** The older model state: the models the agent lists and the current one. Kept beside the
 *  config options and modes; the UI prefers a `model` config option when there is one. */
export interface LegacyModelState {
  readonly currentModelId: string;
  readonly availableModels: readonly LegacyModelInfo[];
}

export type TextItemKind = "user_message" | "agent_message" | "thought";

export interface Session {
  readonly id: SessionId | null;
  readonly cwd: string | null;
  /** The additional directories the client sent when it started or opened the session (an ordered
   *  list of absolute paths, empty when none), or last replaced; never taken from the agent's answers. */
  readonly additionalDirectories: readonly string[];
  /** From `initialize`; null when the agent sent no `agentInfo`. */
  readonly agent: AgentInfo | null;
  readonly connection: ConnectionState;
  readonly state: TurnState;
  readonly stopReason: StopReason | null;
  readonly configOptions: readonly SessionConfigOption[];
  readonly modes: SessionModeState | null;
  /** The older model state from the `models` field of the response that opened the session
   *  (`session/set_model` and `legacy_model_selected` change its current model); null when the
   *  agent sent none or a value of the wrong shape. */
  readonly models: LegacyModelState | null;
  readonly usage: UsageUpdate | null;
  /** The agent's commands from the latest `available_commands_update`, replaced in full. */
  readonly commands: readonly AgentCommand[];
  /** The latest title the agent reported (`session_info_update`), sanitised and on one line;
   *  null when none was reported or it was cleared. */
  readonly title: string | null;
  /** The agent's last-activity time as reported (`session_info_update`, an ISO 8601 string kept
   *  as received after sanitising); null when none was reported or it was cleared. */
  readonly updatedAt: string | null;
  /** Set between `session_opening` and `session_opened`: how the session is being opened. */
  readonly opening: SessionOpenMode | null;
  /** True only while a `session/load` history is arriving (between `session_opening` with mode
   *  `load` and `session_opened`): every item created then has origin `replay`, and the state
   *  stays `idle`. False for a resume, which replays nothing. */
  readonly replaying: boolean;
  /** The live plan, replaced in full by each `plan` update (spec "Plans replace in full"). */
  readonly plan: readonly PlanEntry[];
  readonly items: ReadonlyMap<string, Item>;
  readonly order: readonly string[];
  /** Next per-session tool call index to assign (starts at 1). */
  readonly nextToolIndex: number;
  /** Counter used to synthesise message/thought item ids when no `messageId` is present. */
  readonly nextRunSeq: number;
  /** Counter used to synthesise marker and committed-plan item ids (never derived from a
   *  timestamp, so ids stay unique even if a test or a fast agent reuses the same `at`). */
  readonly nextMarkerSeq: number;
  /** The item id currently receiving message/thought chunks, so the reducer can tell when "a
   *  different item begins" and finalise the previous one (spec "Items become final at defined
   *  points"). Reset when the turn ends. */
  readonly liveTextItemId: string | null;
  /** Tracks the current contiguous run of same-kind, messageId-less chunks within the turn, so a
   *  later chunk of the same kind after an intervening different kind starts a new synthesised
   *  item rather than reattaching to an earlier one. Reset when the turn ends. */
  readonly activeRun: { readonly kind: TextItemKind; readonly itemId: string } | null;
  readonly turn: TurnRuntime | null;
}

export function createSession(): Session {
  return {
    id: null,
    cwd: null,
    additionalDirectories: [],
    agent: null,
    connection: "connected",
    state: "idle",
    stopReason: null,
    configOptions: [],
    modes: null,
    models: null,
    usage: null,
    commands: [],
    title: null,
    updatedAt: null,
    opening: null,
    replaying: false,
    plan: [],
    items: new Map(),
    order: [],
    nextToolIndex: 1,
    nextRunSeq: 1,
    nextMarkerSeq: 1,
    liveTextItemId: null,
    activeRun: null,
    turn: null,
  };
}

// -- Events ----------------------------------------------------------------------------------

/**
 * The reducer's input: ACP v1 `session/update` payloads (wrapped with the timestamp of arrival,
 * since the SDK's updates carry none, design task 3.3) plus client-side events. Timestamps are
 * always supplied by the caller; the reducer never reads the clock, so it stays pure.
 */
export type ModelEvent =
  | {
      readonly type: "session_created";
      readonly response: NewSessionResponse;
      readonly cwd: string;
      /** The additional directories sent with the request; default none. */
      readonly additionalDirectories?: readonly string[];
      /** `agentInfo` from the `initialize` response, if any. */
      readonly agentInfo?: Implementation | null;
      readonly at: number;
    }
  /** Sent before `session/load` or `session/resume` is requested, so replayed updates find the
   *  session already identified. A load starts a replay (`replaying`); a resume does not. */
  | {
      readonly type: "session_opening";
      readonly mode: SessionOpenMode;
      readonly sessionId: SessionId;
      readonly cwd: string;
      /** The additional directories sent with the request; default none. */
      readonly additionalDirectories?: readonly string[];
      /** `agentInfo` from the `initialize` response, if any. */
      readonly agentInfo?: Implementation | null;
      readonly at: number;
    }
  /** Sent when the load or resume response arrives, behind every replayed update: records the
   *  response's config options and modes, ends the replay, makes everything final and, for a
   *  resume, adds the "history is not available" marker. */
  | {
      readonly type: "session_opened";
      readonly response: LoadSessionResponse | ResumeSessionResponse;
      readonly at: number;
    }
  /** The client changed the directories of the session in use (`session/resume` with a new list):
   *  replaces `additionalDirectories`, adds no item and no marker. */
  | { readonly type: "additional_directories_replaced"; readonly additionalDirectories: readonly string[]; readonly at: number }
  | { readonly type: "session_update"; readonly update: SessionUpdate; readonly at: number }
  /** A notice from the client itself, not the agent (mvp-sessions: the session directory marker,
   *  sent after a load or resume): appended at the end as a final `notice` marker with origin
   *  `replay`, so it never reads as activity from another client; the state is unchanged. */
  | { readonly type: "client_notice"; readonly text: string; readonly at: number }
  | { readonly type: "prompt_sent"; readonly text: string; readonly at: number }
  | { readonly type: "prompt_response"; readonly stopReason: StopReason; readonly at: number }
  | { readonly type: "prompt_error"; readonly message: string; readonly at: number }
  | {
      readonly type: "permission_opened";
      readonly toolCallId: string;
      readonly request: RequestPermissionRequest;
      readonly at: number;
    }
  | {
      readonly type: "permission_answered";
      readonly toolCallId: string;
      readonly optionId: string;
      readonly optionKind: PermissionOptionKind;
      readonly at: number;
    }
  | { readonly type: "permission_cancelled"; readonly toolCallId: string; readonly at: number }
  /** The agent withdrew the request (`$/cancel_request`): the record closes with outcome
   *  `withdrawn` and any other open request stays open. */
  | { readonly type: "permission_withdrawn"; readonly toolCallId: string; readonly at: number }
  /** An `elicitation/create` request opened. It adds no item; `elicitationId` is any key unique
   *  among the open requests (the JSON-RPC request id, say) that `elicitation_closed` repeats. */
  | { readonly type: "elicitation_opened"; readonly elicitationId: string; readonly at: number }
  /** The request closed: accepted, declined, cancelled or completed. */
  | { readonly type: "elicitation_closed"; readonly elicitationId: string; readonly at: number }
  /** The option list from a `session/set_config_option` response: replaces the session's config
   *  options in full and changes nothing else (the `config_option_update` update does the same). */
  | { readonly type: "config_options_replaced"; readonly configOptions: readonly SessionConfigOption[]; readonly at: number }
  /** The agent accepted `session/set_model` for this model (the unstable API has no model
   *  update notification, so this is how the current legacy model changes): sets the current
   *  model of the legacy model state and nothing else. */
  | { readonly type: "legacy_model_selected"; readonly modelId: string; readonly at: number }
  | { readonly type: "agent_exited"; readonly exitCode: number | null; readonly at: number };

/** Debug information for an ignored `sessionUpdate` variant (task 3.4: "expose a hook ... so the
 *  caller can debug-log it"). Passed to the optional `onDebug` callback in `reduce`. */
export interface UnknownUpdateDebugInfo {
  readonly kind: "unknown_session_update";
  readonly sessionUpdate: string;
}

/** Debug information for a `current_mode_update` that names a mode the state does not list (or
 *  arrives when the session has no legacy mode state): recorded or ignored, never an error. */
export interface UnknownModeDebugInfo {
  readonly kind: "unknown_mode";
  readonly modeId: string;
}

/** Debug information for a `models` field of a session response that is not a legacy model state
 *  (the wrong shape): ignored, never an error. */
export interface InvalidModelsDebugInfo {
  readonly kind: "invalid_models";
}

/** Debug information for a `legacy_model_selected` event that names a model the legacy model
 *  state does not list (or arrives when the session has none): recorded or ignored, never an
 *  error. */
export interface UnknownModelDebugInfo {
  readonly kind: "unknown_model";
  readonly modelId: string;
}

export type ModelDebugInfo = UnknownUpdateDebugInfo | UnknownModeDebugInfo | InvalidModelsDebugInfo | UnknownModelDebugInfo;
