// The ACP v1 update reducer (design D2, D3, spec `model-session`).
//
// `reduce(session, event) -> session` is a pure function: given the same session and event (and,
// where relevant, the same `at` timestamp carried on the event) it always returns the same next
// session. It never reads the clock, never mutates its arguments, and never throws for
// unrecognised `sessionUpdate` variants.

import type {
  AvailableCommand,
  Implementation,
  LoadSessionResponse,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  RequestPermissionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { contentBlockText } from "./content.ts";
import { sanitise } from "./sanitiser.ts";
import type {
  AgentCommand,
  AgentInfo,
  Item,
  ItemOrigin,
  LegacyModelState,
  MarkerItem,
  ModelDebugInfo,
  ModelEvent,
  PermissionRecordItem,
  Session,
  TextItemKind,
  ToolCallItem,
  ToolCallItemContent,
} from "./types.ts";

// -- Small helpers -----------------------------------------------------------------------------

function originFor(session: Session): ItemOrigin {
  if (session.replaying) return "replay";
  return session.turn === null ? "other" : "self";
}

function appendItem(session: Session, item: Item): Session {
  const items = new Map(session.items);
  items.set(item.id, item);
  const order = session.items.has(item.id) ? session.order : [...session.order, item.id];
  return { ...session, items, order };
}

function updateItem(session: Session, id: string, updater: (item: Item) => Item): Session {
  const existing = session.items.get(id);
  if (!existing) return session;
  const updated = updater(existing);
  if (updated === existing) return session;
  const items = new Map(session.items);
  items.set(id, updated);
  return { ...session, items };
}

function finaliseItem(session: Session, id: string | null): Session {
  if (id === null) return session;
  return updateItem(session, id, (item) => (item.status === "final" ? item : { ...item, status: "final" }));
}

// -- Message and thought chunks (task 3.2) ----------------------------------------------------

function handleTextChunk(
  session: Session,
  kind: TextItemKind,
  messageId: string | null,
  text: string,
): Session {
  let itemId: string;
  let isNew: boolean;

  if (messageId) {
    itemId = `${kind}:${messageId}`;
    isNew = !session.items.has(itemId);
  } else if (session.activeRun && session.activeRun.kind === kind) {
    itemId = session.activeRun.itemId;
    isNew = false;
  } else {
    itemId = `run:${kind}:${session.nextRunSeq}`;
    isNew = true;
  }

  // A different item beginning finalises whatever text item was previously live (spec: "Items
  // become final at defined points").
  let next = isNew ? finaliseItem(session, session.liveTextItemId) : session;

  if (isNew) {
    const item: Item = { id: itemId, status: "live", origin: originFor(next), kind, text };
    next = appendItem(next, item);
    if (!messageId) {
      next = { ...next, nextRunSeq: next.nextRunSeq + 1 };
    }
  } else {
    next = updateItem(next, itemId, (existing) => {
      if (existing.kind !== kind) return existing;
      return { ...existing, text: existing.text + text, status: "live" };
    });
  }

  return {
    ...next,
    liveTextItemId: itemId,
    activeRun: messageId ? null : { kind, itemId },
  };
}

// -- Tool calls (task 3.3) ---------------------------------------------------------------------

interface ToolCallFields {
  readonly toolCallId: string;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly kind?: ToolKind | null;
  readonly status?: ToolCallStatus | null;
  readonly content?: readonly ToolCallContent[] | null;
  readonly locations?: readonly ToolCallLocation[] | null;
  /** The update's `rawOutput`, any JSON value; only `rawOutputTextOf` reads it. */
  readonly rawOutput?: unknown;
}

/** The text form of a `rawOutput` (design D3 of `day-one-feedback`): the value when it is a
 *  string, or its `output` field when it is an object whose `output` is a string (Auggie's shape);
 *  anything else records nothing (undefined). Sanitised on entry like other agent text. */
function rawOutputTextOf(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") return sanitise(rawOutput);
  if (typeof rawOutput === "object" && rawOutput !== null && !Array.isArray(rawOutput)) {
    const output = (rawOutput as { output?: unknown }).output;
    if (typeof output === "string") return sanitise(output);
  }
  return undefined;
}

function mapToolCallContent(content: readonly ToolCallContent[] | null | undefined): ToolCallItemContent[] | undefined {
  if (content == null) return undefined;
  return content.map((entry): ToolCallItemContent => {
    switch (entry.type) {
      case "content":
        return { type: "text", text: contentBlockText(entry.content) };
      case "diff":
        return {
          type: "diff",
          path: sanitise(entry.path),
          oldText: entry.oldText != null ? sanitise(entry.oldText) : null,
          newText: sanitise(entry.newText),
        };
      case "terminal":
        // Client terminals are not supported (design 5.1): recorded so the renderer can show
        // "terminal output unavailable" instead of trying to embed anything from it.
        return { type: "terminal_unavailable" };
    }
  });
}

function mapLocations(locations: readonly ToolCallLocation[] | null | undefined): ToolCallLocation[] | undefined {
  if (locations == null) return undefined;
  return locations.map((location) => ({ ...location, path: sanitise(location.path) }));
}

function isTerminalToolStatus(status: ToolCallStatus): boolean {
  return status === "completed" || status === "failed";
}

/** A non-text item beginning is "a different item" (spec "Items become final at defined points"):
 *  it finalises the live message or thought and ends the current contiguous run, so a later
 *  messageId-less chunk starts a new item instead of reopening the finalised one. */
function beginOtherItem(session: Session): Session {
  if (session.liveTextItemId === null && session.activeRun === null) return session;
  return { ...finaliseItem(session, session.liveTextItemId), liveTextItemId: null, activeRun: null };
}

function upsertToolCall(session: Session, fields: ToolCallFields, at: number): Session {
  const id = `tool:${fields.toolCallId}`;
  const existing = session.items.get(id);

  if (!existing || existing.kind !== "tool_call") {
    session = beginOtherItem(session);
    const status = fields.status ?? "pending";
    const becomesFinal = isTerminalToolStatus(status);
    const index = session.nextToolIndex;
    const item: ToolCallItem = {
      id,
      status: becomesFinal ? "final" : "live",
      origin: originFor(session),
      kind: "tool_call",
      toolCallId: fields.toolCallId,
      index,
      title: fields.title ? sanitise(fields.title) : "",
      toolName: fields.name ? sanitise(fields.name) : null,
      toolKind: fields.kind ?? null,
      toolStatus: status,
      content: mapToolCallContent(fields.content) ?? [],
      locations: mapLocations(fields.locations) ?? [],
      rawOutputText: rawOutputTextOf(fields.rawOutput) ?? null,
      startedAt: at,
      endedAt: becomesFinal ? at : null,
    };
    return { ...appendItem(session, item), nextToolIndex: index + 1 };
  }

  return updateItem(session, id, (item) => {
    if (item.kind !== "tool_call") return item;
    const nextStatus = fields.status ?? item.toolStatus;
    const becomesFinal = isTerminalToolStatus(nextStatus);
    return {
      ...item,
      title: fields.title != null ? sanitise(fields.title) : item.title,
      toolName: fields.name != null ? sanitise(fields.name) : item.toolName,
      toolKind: fields.kind != null ? fields.kind : item.toolKind,
      toolStatus: nextStatus,
      status: becomesFinal ? "final" : item.status,
      content: fields.content != null ? (mapToolCallContent(fields.content) ?? item.content) : item.content,
      locations: fields.locations != null ? (mapLocations(fields.locations) ?? item.locations) : item.locations,
      rawOutputText: rawOutputTextOf(fields.rawOutput) ?? item.rawOutputText,
      endedAt: item.endedAt ?? (becomesFinal ? at : null),
    };
  });
}

// -- Session metadata: config options, modes, agent identity --------------------------------------
//
// Every string is sanitised, identifiers included (sanitise is the identity on any ordinary id, so
// round-tripping them to the agent later is unaffected). `_meta` is kept as is: it is never
// rendered. Permission option ids are the one exception, see `sanitiseOption`.

function sanitiseOptional(text: string | null | undefined): string | null | undefined {
  return typeof text === "string" ? sanitise(text) : text;
}

function sanitiseSelectOption(option: SessionConfigSelectOption): SessionConfigSelectOption {
  return { ...option, value: sanitise(option.value), name: sanitise(option.name), description: sanitiseOptional(option.description) };
}

function sanitiseConfigOption(option: SessionConfigOption): SessionConfigOption {
  const common = {
    id: sanitise(option.id),
    name: sanitise(option.name),
    description: sanitiseOptional(option.description),
    category: sanitiseOptional(option.category),
  };
  if (option.type !== "select") return { ...option, ...common };
  const options = (option.options ?? []).map((entry) =>
    "group" in entry
      ? { ...entry, group: sanitise(entry.group), name: sanitise(entry.name), options: entry.options.map(sanitiseSelectOption) }
      : sanitiseSelectOption(entry),
  ) as typeof option.options;
  // Defensive against a malformed option (a missing `currentValue` or `options`).
  return { ...option, ...common, currentValue: sanitiseOptional(option.currentValue) as string, options };
}

/** `config_options_replaced` and `config_option_update`: the new list replaces the old in full
 *  (design D10) and nothing else in the session changes, so items, modes and the plan keep
 *  their references. */
function replaceConfigOptions(session: Session, configOptions: readonly SessionConfigOption[]): Session {
  return { ...session, configOptions: configOptions.map(sanitiseConfigOption) };
}

/** `current_mode_update`: sets the current legacy mode. A mode the state does not list is
 *  recorded all the same and reported through `onDebug`; with no mode state at all there is
 *  nothing to set (the update would need an invented mode list), so it is only reported. */
function handleCurrentMode(session: Session, modeId: string, onDebug?: (info: ModelDebugInfo) => void): Session {
  const id = sanitise(modeId);
  if (!session.modes || !session.modes.availableModes.some((mode) => mode.id === id)) {
    onDebug?.({ kind: "unknown_mode", modeId: id });
  }
  if (!session.modes) return session;
  return { ...session, modes: { ...session.modes, currentModeId: id } };
}

function sanitiseCommands(commands: readonly AvailableCommand[]): AgentCommand[] {
  return commands.map((command) => ({
    name: sanitise(command.name),
    description: sanitise(command.description ?? ""),
    inputHint: command.input?.hint != null ? sanitise(command.input.hint) : null,
  }));
}

function sanitiseModes(modes: SessionModeState): SessionModeState {
  return {
    ...modes,
    currentModeId: sanitise(modes.currentModeId),
    availableModes: modes.availableModes.map((mode) => ({
      ...mode,
      id: sanitise(mode.id),
      name: sanitise(mode.name),
      description: sanitiseOptional(mode.description),
    })),
  };
}

// -- The older model state (`models`), a compatibility fallback (design 5.5, Models) -----------------
//
// `@agentclientprotocol/sdk` 1.5.0 no longer types `models`, so the response field is read as
// `unknown` and accepted only in the shape the older unstable API gave it. Anything else is
// ignored and reported, never raised.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A structural guard and sanitiser in one: the sanitised legacy model state, or null when
 *  `value` is not one (an object with a string `currentModelId` and an `availableModels` array
 *  of objects with string `modelId` and `name` and an optional string-or-null `description`;
 *  other keys such as `_meta` are dropped). */
function sanitiseLegacyModels(value: unknown): LegacyModelState | null {
  if (!isRecord(value) || typeof value.currentModelId !== "string" || !Array.isArray(value.availableModels)) return null;
  const availableModels = [];
  for (const entry of value.availableModels as unknown[]) {
    if (!isRecord(entry) || typeof entry.modelId !== "string" || typeof entry.name !== "string") return null;
    const description = entry.description;
    if (description != null && typeof description !== "string") return null;
    availableModels.push({
      modelId: sanitise(entry.modelId),
      name: sanitise(entry.name),
      description: typeof description === "string" ? sanitise(description) : null,
    });
  }
  return { currentModelId: sanitise(value.currentModelId), availableModels };
}

/** The `models` field of a session response: `undefined` for an absent or `null` field (the
 *  caller decides what that means), else the legacy model state, or null when it is malformed
 *  (reported through `onDebug`). */
function readLegacyModels(response: object, onDebug?: (info: ModelDebugInfo) => void): LegacyModelState | null | undefined {
  const raw = (response as { models?: unknown }).models;
  if (raw == null) return undefined;
  const models = sanitiseLegacyModels(raw);
  if (!models) onDebug?.({ kind: "invalid_models" });
  return models;
}

/** `legacy_model_selected`: sets the current model of the legacy model state after the agent
 *  accepted `session/set_model`. A model the state does not list is recorded all the same and
 *  reported; with no state at all there is nothing to set, so it is only reported. */
function handleLegacyModelSelected(session: Session, modelId: string, onDebug?: (info: ModelDebugInfo) => void): Session {
  const id = sanitise(modelId);
  if (!session.models || !session.models.availableModels.some((model) => model.modelId === id)) {
    onDebug?.({ kind: "unknown_model", modelId: id });
  }
  if (!session.models) return session;
  return { ...session, models: { ...session.models, currentModelId: id } };
}

function agentInfoFrom(info: Implementation | null | undefined): AgentInfo | null {
  if (!info) return null;
  return { name: sanitise(info.name), title: sanitiseOptional(info.title) ?? null, version: sanitiseOptional(info.version) ?? null };
}

/** Option names are shown; `optionId` is kept verbatim because it is never rendered and is sent
 *  back to the agent as the answer, where it must match the request exactly. */
function sanitiseOption(option: PermissionOption): PermissionOption {
  return { ...option, name: sanitise(option.name) };
}

// -- Session titles and activity time ------------------------------------------------------------

/** A title is shown in lists and printed after exit, so it is cleaned as strictly as approval
 *  text (bidi overrides and zero-width characters go too) and held on one line: every run of
 *  line breaks and tabs, including U+2028 and U+2029, becomes one space. Null when nothing
 *  printable is left. */
function cleanTitle(title: string): string | null {
  const line = sanitise(title, "approval").replace(/[\n\t\u2028\u2029]+/g, " ").trim();
  return line === "" ? null : line;
}

/** `session_info_update`: a string sets, `null` clears, an absent field leaves the value alone. */
function handleSessionInfo(session: Session, update: { title?: string | null; updatedAt?: string | null }): Session {
  let next = session;
  if (update.title !== undefined) {
    next = { ...next, title: update.title === null ? null : cleanTitle(update.title) };
  }
  if (update.updatedAt !== undefined) {
    const updatedAt = update.updatedAt === null ? null : sanitise(update.updatedAt, "approval").trim();
    next = { ...next, updatedAt: updatedAt === "" ? null : updatedAt };
  }
  return next;
}

// -- Load and resume ------------------------------------------------------------------------------

/** Everything still live becomes final in one pass (one copy of the item map, however long the
 *  history), and the text run state is cleared so a later chunk starts a new item. */
function finaliseAllItems(session: Session): Session {
  let items: Map<string, Item> | null = null;
  for (const id of session.order) {
    const item = session.items.get(id);
    if (item && item.status === "live") {
      items ??= new Map(session.items);
      items.set(id, { ...item, status: "final" } as Item);
    }
  }
  return { ...(items ? { ...session, items } : session), liveTextItemId: null, activeRun: null };
}

const RESUME_MARKER_TEXT = "Session resumed: the history is not available from this agent";

function handleSessionOpened(
  session: Session,
  response: LoadSessionResponse | ResumeSessionResponse,
  onDebug?: (info: ModelDebugInfo) => void,
): Session {
  let next = finaliseAllItems(session);
  next = {
    ...next,
    configOptions: response.configOptions != null ? response.configOptions.map(sanitiseConfigOption) : next.configOptions,
    modes: response.modes != null ? sanitiseModes(response.modes) : next.modes,
    models: readLegacyModels(response, onDebug) ?? next.models,
  };
  if (session.opening === "resume") {
    // Client-made notice, not agent activity: `replay` keeps it out of "activity from another
    // client" (the resume has no turn running and nothing was replayed).
    const marker: MarkerItem = {
      id: `marker:${next.nextMarkerSeq}`,
      status: "final",
      origin: "replay",
      kind: "marker",
      markerKind: "notice",
      text: RESUME_MARKER_TEXT,
    };
    next = { ...appendItem(next, marker), nextMarkerSeq: next.nextMarkerSeq + 1 };
  }
  return { ...next, opening: null, replaying: false };
}

// -- Permissions (design 5.4) -------------------------------------------------------------------

function handlePermissionOpened(
  session: Session,
  toolCallId: string,
  request: RequestPermissionRequest,
  at: number,
): Session {
  let next = upsertToolCall(
    session,
    {
      toolCallId,
      title: request.toolCall.title,
      name: request.toolCall.name,
      kind: request.toolCall.kind,
      status: request.toolCall.status,
      content: request.toolCall.content,
      locations: request.toolCall.locations,
    },
    at,
  );

  const toolItem = next.items.get(`tool:${toolCallId}`);
  const title =
    request.toolCall.title != null
      ? sanitise(request.toolCall.title)
      : toolItem && toolItem.kind === "tool_call"
        ? toolItem.title
        : "";

  next = beginOtherItem(next);
  const item: PermissionRecordItem = {
    id: `permission:${toolCallId}`,
    status: "live",
    origin: originFor(next),
    kind: "permission_record",
    toolCallId,
    title,
    options: request.options.map(sanitiseOption),
    outcome: { type: "pending" },
  };
  next = appendItem(next, item);

  const turn = next.turn ?? emptyTurn(at);
  const ids = turn.openPermissionToolCallIds.includes(toolCallId)
    ? turn.openPermissionToolCallIds
    : [...turn.openPermissionToolCallIds, toolCallId];
  return withOpenRequests(next, { ...turn, openPermissionToolCallIds: ids, openPermissionToolCallId: ids[0] ?? null });
}

function closePermission(
  session: Session,
  toolCallId: string,
  outcome: PermissionRecordItem["outcome"],
): Session {
  const next = updateItem(session, `permission:${toolCallId}`, (item) => {
    if (item.kind !== "permission_record") return item;
    return { ...item, status: "final", outcome };
  });

  const turn = next.turn;
  if (!turn || !turn.openPermissionToolCallIds.includes(toolCallId)) return next;
  const ids = turn.openPermissionToolCallIds.filter((id) => id !== toolCallId);
  return withOpenRequests(next, { ...turn, openPermissionToolCallIds: ids, openPermissionToolCallId: ids[0] ?? null });
}

// -- Elicitation requests (they add no item; only the turn state follows them) --------------------

function openElicitation(session: Session, elicitationId: string, at: number): Session {
  const turn = session.turn ?? emptyTurn(at);
  if (turn.openElicitationIds.includes(elicitationId)) return session;
  return withOpenRequests(session, { ...turn, openElicitationIds: [...turn.openElicitationIds, elicitationId] });
}

function closeElicitation(session: Session, elicitationId: string): Session {
  const turn = session.turn;
  if (!turn || !turn.openElicitationIds.includes(elicitationId)) return session;
  return withOpenRequests(session, {
    ...turn,
    openElicitationIds: turn.openElicitationIds.filter((id) => id !== elicitationId),
  });
}

/** Stores the turn and derives the state from it: `requires_action` while any permission or
 *  elicitation request is open, `running` once none is. */
function withOpenRequests(session: Session, turn: NonNullable<Session["turn"]>): Session {
  const open = turn.openPermissionToolCallIds.length > 0 || turn.openElicitationIds.length > 0;
  return { ...session, state: open ? "requires_action" : "running", turn };
}

function emptyTurn(startedAt: number): NonNullable<Session["turn"]> {
  return {
    startedAt,
    openPermissionToolCallIds: [],
    openPermissionToolCallId: null,
    openElicitationIds: [],
    planReportedThisTurn: false,
  };
}

// -- Turn lifecycle (task 3.4) ------------------------------------------------------------------

function finaliseLiveItems(session: Session): Session {
  let next = finaliseItem(session, session.liveTextItemId);
  for (const id of next.order) {
    const item = next.items.get(id);
    if (item && item.kind === "tool_call" && item.status === "live") {
      next = updateItem(next, id, (it) => (it.kind === "tool_call" ? { ...it, status: "final" } : it));
    }
  }
  return { ...next, liveTextItemId: null, activeRun: null };
}

function commitPlanIfReported(session: Session): Session {
  if (!session.turn?.planReportedThisTurn || session.plan.length === 0) return session;
  const id = `plan:${session.nextMarkerSeq}`;
  const item: Item = {
    id,
    status: "final",
    origin: originFor(session),
    kind: "plan",
    entries: session.plan,
  };
  return { ...appendItem(session, item), nextMarkerSeq: session.nextMarkerSeq + 1 };
}

function endTurn(
  session: Session,
  at: number,
  marker: Omit<Extract<MarkerItem, { markerKind: "turn_end" }>, "id" | "status" | "origin"> | null,
): Session {
  let next = finaliseLiveItems(session);
  next = commitPlanIfReported(next);

  if (marker) {
    const item: MarkerItem = {
      id: `marker:${next.nextMarkerSeq}`,
      status: "final",
      origin: originFor(next),
      ...marker,
    };
    next = { ...appendItem(next, item), nextMarkerSeq: next.nextMarkerSeq + 1 };
  }

  return { ...next, state: "idle", turn: null };
}

function appendNoticeOrError(session: Session, markerKind: "error" | "notice", text: string): Session {
  const item: MarkerItem = {
    id: `marker:${session.nextMarkerSeq}`,
    status: "final",
    origin: originFor(session),
    kind: "marker",
    markerKind,
    text: sanitise(text),
  };
  return { ...appendItem(session, item), nextMarkerSeq: session.nextMarkerSeq + 1 };
}

// -- session/update dispatch ---------------------------------------------------------------------

function handleSessionUpdate(
  session: Session,
  update: SessionUpdate,
  at: number,
  onDebug?: (info: ModelDebugInfo) => void,
): Session {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return handleTextChunk(session, "user_message", update.messageId ?? null, contentBlockText(update.content));

    case "agent_message_chunk":
      return handleTextChunk(session, "agent_message", update.messageId ?? null, contentBlockText(update.content));

    case "agent_thought_chunk":
      return handleTextChunk(session, "thought", update.messageId ?? null, contentBlockText(update.content));

    case "tool_call":
      return upsertToolCall(
        session,
        {
          toolCallId: update.toolCallId,
          title: update.title,
          name: update.name,
          kind: update.kind,
          status: update.status,
          content: update.content,
          locations: update.locations,
          rawOutput: update.rawOutput,
        },
        at,
      );

    case "tool_call_update":
      return upsertToolCall(
        session,
        {
          toolCallId: update.toolCallId,
          title: update.title,
          name: update.name,
          kind: update.kind,
          status: update.status,
          content: update.content,
          locations: update.locations,
          rawOutput: update.rawOutput,
        },
        at,
      );

    case "plan": {
      const entries: readonly PlanEntry[] = update.entries.map((entry) => ({
        ...entry,
        content: sanitise(entry.content),
      }));
      return {
        ...session,
        plan: entries,
        turn: session.turn ? { ...session.turn, planReportedThisTurn: true } : session.turn,
      };
    }

    case "usage_update":
      return {
        ...session,
        usage: {
          used: update.used,
          size: update.size,
          // `cost` is the cumulative session cost, so an update without it keeps the one recorded
          // and only an explicit `null` clears it (`claude-agent-acp` sends cost-less updates on
          // every streamed message). The currency is shown, so it is sanitised like any agent
          // text; `_meta` is dropped.
          cost:
            update.cost === undefined
              ? (session.usage?.cost ?? null)
              : update.cost
                ? { amount: update.cost.amount, currency: sanitise(update.cost.currency) }
                : null,
        },
      };

    case "session_info_update":
      return handleSessionInfo(session, update);

    case "config_option_update":
      return replaceConfigOptions(session, update.configOptions);

    case "current_mode_update":
      return handleCurrentMode(session, update.currentModeId, onDebug);

    case "available_commands_update":
      return { ...session, commands: sanitiseCommands(update.availableCommands) };

    default:
      // Every other variant (notice, compaction_update, compaction_summary_chunk, plan_update,
      // plan_removed, and any string the v1 union does not define at all) is out of the
      // implemented subset: ignored, not an error (spec "Unknown updates are ignored, not
      // errors").
      onDebug?.({ kind: "unknown_session_update", sessionUpdate: (update as { sessionUpdate: string }).sessionUpdate });
      return session;
  }
}

// -- Public reducer -------------------------------------------------------------------------------

/**
 * Fold one event into the session. Immutable: `session` is never mutated, and structural sharing
 * means only the parts of the session that changed get new references (design D2).
 *
 * `onDebug` is an optional hook (not part of the D2 signature's required arguments) so a caller
 * can log ignored `sessionUpdate` variants without the reducer itself doing any I/O (task 3.4:
 * "expose a hook or return value so the caller can debug-log it, since the reducer itself must
 * stay pure").
 */
export function reduce(
  session: Session,
  event: ModelEvent,
  onDebug?: (info: ModelDebugInfo) => void,
): Session {
  switch (event.type) {
    case "session_created":
      return {
        ...session,
        id: event.response.sessionId,
        cwd: event.cwd,
        additionalDirectories: [...(event.additionalDirectories ?? [])],
        agent: agentInfoFrom(event.agentInfo),
        connection: "connected",
        configOptions: (event.response.configOptions ?? []).map(sanitiseConfigOption),
        modes: event.response.modes ? sanitiseModes(event.response.modes) : null,
        models: readLegacyModels(event.response, onDebug) ?? null,
      };

    case "session_opening":
      return {
        ...session,
        id: event.sessionId,
        cwd: event.cwd,
        additionalDirectories: [...(event.additionalDirectories ?? [])],
        agent: agentInfoFrom(event.agentInfo),
        connection: "connected",
        opening: event.mode,
        replaying: event.mode === "load",
      };

    case "session_opened":
      return handleSessionOpened(session, event.response, onDebug);

    case "additional_directories_replaced":
      return { ...session, additionalDirectories: [...event.additionalDirectories] };

    case "session_update":
      return handleSessionUpdate(session, event.update, event.at, onDebug);

    case "client_notice": {
      // acp-tui's own notice (the session directory marker): not the agent's activity, so
      // `replay`, as the resume marker; sanitised all the same.
      const item: MarkerItem = {
        id: `marker:${session.nextMarkerSeq}`,
        status: "final",
        origin: "replay",
        kind: "marker",
        markerKind: "notice",
        text: sanitise(event.text),
      };
      return { ...appendItem(session, item), nextMarkerSeq: session.nextMarkerSeq + 1 };
    }

    case "prompt_sent": {
      const item: Item = {
        id: `user:${session.nextMarkerSeq}`,
        status: "final",
        origin: "self",
        kind: "user_message",
        text: sanitise(event.text),
      };
      const withItem = { ...appendItem(session, item), nextMarkerSeq: session.nextMarkerSeq + 1 };
      return {
        ...withItem,
        state: "running",
        stopReason: null,
        turn: emptyTurn(event.at),
      };
    }

    case "prompt_response": {
      const durationMs = session.turn ? Math.max(0, event.at - session.turn.startedAt) : 0;
      const next = endTurn(session, event.at, {
        kind: "marker",
        markerKind: "turn_end",
        stopReason: event.stopReason,
        durationMs,
        usage: session.usage,
      });
      return { ...next, stopReason: event.stopReason };
    }

    case "prompt_error": {
      const next = endTurn(session, event.at, null);
      return appendNoticeOrError(next, "error", event.message);
    }

    case "permission_opened":
      return handlePermissionOpened(session, event.toolCallId, event.request, event.at);

    case "permission_answered":
      return closePermission(session, event.toolCallId, {
        type: "answered",
        optionId: event.optionId,
        optionKind: event.optionKind as PermissionOptionKind,
      });

    case "permission_cancelled":
      return closePermission(session, event.toolCallId, { type: "cancelled" });

    case "permission_withdrawn":
      return closePermission(session, event.toolCallId, { type: "withdrawn" });

    case "elicitation_opened":
      return openElicitation(session, event.elicitationId, event.at);

    case "elicitation_closed":
      return closeElicitation(session, event.elicitationId);

    case "config_options_replaced":
      return replaceConfigOptions(session, event.configOptions);

    case "legacy_model_selected":
      return handleLegacyModelSelected(session, event.modelId, onDebug);

    case "agent_exited": {
      const next = session.turn ? endTurn(session, event.at, null) : session;
      const withNotice = appendNoticeOrError(
        next,
        "notice",
        event.exitCode === null ? "agent exited" : `agent exited (code ${event.exitCode})`,
      );
      return { ...withNotice, connection: "disconnected" };
    }

    default:
      return session;
  }
}
