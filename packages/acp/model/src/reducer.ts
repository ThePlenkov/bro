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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originFor(session: Session): ItemOrigin {
  if (session.replaying) return "replay";
  // an archive-sourced turn is observed activity — "self" is reserved
  // for turns this client actually prompted
  return session.turn === null || session.turn.archive ? "other" : "self";
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

interface TextChunkTarget {
  readonly itemId: string;
  readonly isNew: boolean;
}

/** Where a chunk lands: a `messageId` pins the item id; an id-less chunk continues the active
 *  run of the same kind, else opens a new run item. */
function textChunkTarget(session: Session, kind: TextItemKind, messageId: string | null): TextChunkTarget {
  if (messageId) {
    const itemId = `${kind}:${messageId}`;
    return { itemId, isNew: !session.items.has(itemId) };
  }
  if (session.activeRun && session.activeRun.kind === kind) {
    return { itemId: session.activeRun.itemId, isNew: false };
  }
  return { itemId: `run:${kind}:${session.nextRunSeq}`, isNew: true };
}

interface NewTextItem {
  readonly itemId: string;
  readonly kind: TextItemKind;
  readonly text: string;
  readonly messageId: string | null;
}

function appendTextItem(session: Session, spec: NewTextItem): Session {
  const item: Item = { id: spec.itemId, status: "live", origin: originFor(session), kind: spec.kind, text: spec.text };
  const next = appendItem(session, item);
  return spec.messageId ? next : { ...next, nextRunSeq: next.nextRunSeq + 1 };
}

function extendTextItem(session: Session, itemId: string, kind: TextItemKind, text: string): Session {
  return updateItem(session, itemId, (existing) => {
    if (existing.kind !== kind) return existing;
    return { ...existing, text: existing.text + text, status: "live" };
  });
}

function handleTextChunk(
  session: Session,
  kind: TextItemKind,
  messageId: string | null,
  text: string,
): Session {
  const { itemId, isNew } = textChunkTarget(session, kind, messageId);

  // A different item beginning finalises whatever text item was previously live (spec: "Items
  // become final at defined points"). A messageId can reopen an existing item, so compare the
  // target with the live item rather than using `isNew`: reopening an earlier item must still
  // seal the item that was live immediately before it.
  const base = session.liveTextItemId === itemId ? session : finaliseItem(session, session.liveTextItemId);
  const next = isNew
    ? appendTextItem(base, { itemId, kind, text, messageId })
    : extendTextItem(base, itemId, kind, text);

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
  if (!isRecord(rawOutput)) return undefined;
  const output = rawOutput.output;
  return typeof output === "string" ? sanitise(output) : undefined;
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

function insertToolCall(session: Session, id: string, fields: ToolCallFields, at: number): Session {
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

/** Text facets of a tool call: every supplied value is sanitised; absent fields keep the
 *  recorded value. */
function mergeToolCallText(item: ToolCallItem, fields: ToolCallFields): ToolCallItem {
  return {
    ...item,
    title: fields.title != null ? sanitise(fields.title) : item.title,
    toolName: fields.name != null ? sanitise(fields.name) : item.toolName,
    toolKind: fields.kind ?? item.toolKind,
  };
}

/** Payload facets: content/locations merge to the update's, else keep the recorded value;
 *  `rawOutput` contributes only when it parses to text. */
function mergeToolCallPayload(item: ToolCallItem, fields: ToolCallFields): ToolCallItem {
  return {
    ...item,
    content: fields.content != null ? (mapToolCallContent(fields.content) ?? item.content) : item.content,
    locations: fields.locations != null ? (mapLocations(fields.locations) ?? item.locations) : item.locations,
    rawOutputText: rawOutputTextOf(fields.rawOutput) ?? item.rawOutputText,
  };
}

/** Lifecycle facets: the supplied status wins; reaching a terminal status seals the item
 *  and stamps its end (the first terminal stamp stands). */
function mergeToolCallStatus(item: ToolCallItem, fields: ToolCallFields, at: number): ToolCallItem {
  const nextStatus = fields.status ?? item.toolStatus;
  const becomesFinal = isTerminalToolStatus(nextStatus);
  return {
    ...item,
    toolStatus: nextStatus,
    status: becomesFinal ? "final" : item.status,
    endedAt: item.endedAt ?? (becomesFinal ? at : null),
  };
}

function patchToolCall(session: Session, id: string, fields: ToolCallFields, at: number): Session {
  return updateItem(session, id, (item) => {
    if (item.kind !== "tool_call") return item;
    return mergeToolCallStatus(mergeToolCallPayload(mergeToolCallText(item, fields), fields), fields, at);
  });
}

function upsertToolCall(session: Session, fields: ToolCallFields, at: number): Session {
  const id = `tool:${fields.toolCallId}`;
  const existing = session.items.get(id);
  if (!existing || existing.kind !== "tool_call") return insertToolCall(session, id, fields, at);
  return patchToolCall(session, id, fields, at);
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

/** One `availableModels` entry in the shape the older unstable API gave it: string `modelId`
 *  and `name`, optional string-or-null `description`. */
interface LegacyModelEntry {
  readonly modelId: string;
  readonly name: string;
  readonly description?: unknown;
}

function isLegacyModelEntry(value: unknown): value is LegacyModelEntry {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    typeof value.name === "string" &&
    (value.description == null || typeof value.description === "string")
  );
}

function isLegacyModelShape(value: unknown): value is { currentModelId: string; availableModels: unknown[] } {
  return isRecord(value) && typeof value.currentModelId === "string" && Array.isArray(value.availableModels);
}

/** A structural guard and sanitiser in one: the sanitised legacy model state, or null when
 *  `value` is not one (an object with a string `currentModelId` and an `availableModels` array
 *  of objects with string `modelId` and `name` and an optional string-or-null `description`;
 *  other keys such as `_meta` are dropped). */
function sanitiseLegacyModels(value: unknown): LegacyModelState | null {
  if (!isLegacyModelShape(value)) return null;
  const entries = value.availableModels;
  if (!entries.every(isLegacyModelEntry)) return null;
  const availableModels = entries.map((entry) => ({
    modelId: sanitise(entry.modelId),
    name: sanitise(entry.name),
    description: typeof entry.description === "string" ? sanitise(entry.description) : null,
  }));
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

  // a permission that opens a turn with no `turn_started` sits in the
  // archive window mid-turn — the fabricated turn is archive-sourced,
  // or the rest of it mislabels `self`
  const turn = next.turn ?? archiveTurn(at);
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
  // same archive rule as permissions: a turn fabricated here is
  // archive-sourced, never `self`
  const turn = session.turn ?? emptyTurn(at, true);
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

function emptyTurn(startedAt: number, archive = false): NonNullable<Session["turn"]> {
  return {
    startedAt,
    openPermissionToolCallIds: [],
    openPermissionToolCallId: null,
    openElicitationIds: [],
    planReportedThisTurn: false,
    archive,
  };
}

/** A request observed in the archive may arrive without its turn-start row.
 *  Keep the fallback turn explicitly observed so later id-less updates cannot
 *  inherit the client-owned (`self`) attribution. */
function archiveTurn(startedAt: number): NonNullable<Session["turn"]> {
  return emptyTurn(startedAt, true);
}

// -- Turn lifecycle (task 3.4) ------------------------------------------------------------------

/** Seals one live tool call when its turn ends: a call the sealed turn abandoned never
 *  completed — "failed" is the terminal the readers key liveness on (keeping pending/
 *  in_progress would glow live forever), and the seal time is its end like every other
 *  terminal. */
function sealLiveToolCall(item: Item, at: number): Item {
  if (item.kind !== "tool_call") return item;
  return {
    ...item,
    status: "final",
    toolStatus: isTerminalToolStatus(item.toolStatus) ? item.toolStatus : "failed",
    endedAt: item.endedAt ?? at,
  };
}

function isLiveToolCall(item: Item | undefined): item is ToolCallItem {
  return item !== undefined && item.kind === "tool_call" && item.status === "live";
}

function finaliseLiveItems(session: Session, at: number): Session {
  let next = finaliseItem(session, session.liveTextItemId);
  for (const id of next.order) {
    const item = next.items.get(id);
    if (isLiveToolCall(item)) {
      next = updateItem(next, id, (it) => sealLiveToolCall(it, at));
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
  let next = finaliseLiveItems(session, at);
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

type SessionUpdateHandler<U extends SessionUpdate = SessionUpdate> = (
  session: Session,
  update: U,
  at: number,
  onDebug?: (info: ModelDebugInfo) => void,
) => Session;

function toolCallFieldsOf(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>): ToolCallFields {
  return {
    toolCallId: update.toolCallId,
    title: update.title,
    name: update.name,
    kind: update.kind,
    status: update.status,
    content: update.content,
    locations: update.locations,
    rawOutput: update.rawOutput,
  };
}

/** `usage_update`: `cost` is the cumulative session cost, so an update without it keeps the
 *  one recorded and only an explicit `null` clears it (`claude-agent-acp` sends cost-less
 *  updates on every streamed message). The currency is shown, so it is sanitised like any
 *  agent text; `_meta` is dropped. */
function handleUsageUpdate(session: Session, update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>): Session {
  const cost =
    update.cost === undefined
      ? (session.usage?.cost ?? null)
      : update.cost
        ? { amount: update.cost.amount, currency: sanitise(update.cost.currency) }
        : null;
  return { ...session, usage: { used: update.used, size: update.size, cost } };
}

function handlePlanUpdate(session: Session, update: Extract<SessionUpdate, { sessionUpdate: "plan" }>): Session {
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

/** One entry per handled `sessionUpdate` variant — adding a variant is a table row, not a
 *  switch arm. */
const SESSION_UPDATE_HANDLERS: {
  [U in SessionUpdate as U["sessionUpdate"]]?: SessionUpdateHandler<U>;
} = {
  user_message_chunk: (session, update) =>
    handleTextChunk(session, "user_message", update.messageId ?? null, contentBlockText(update.content)),
  agent_message_chunk: (session, update) =>
    handleTextChunk(session, "agent_message", update.messageId ?? null, contentBlockText(update.content)),
  agent_thought_chunk: (session, update) =>
    handleTextChunk(session, "thought", update.messageId ?? null, contentBlockText(update.content)),
  tool_call: (session, update, at) => upsertToolCall(session, toolCallFieldsOf(update), at),
  tool_call_update: (session, update, at) => upsertToolCall(session, toolCallFieldsOf(update), at),
  plan: handlePlanUpdate,
  usage_update: handleUsageUpdate,
  session_info_update: handleSessionInfo,
  config_option_update: (session, update) => replaceConfigOptions(session, update.configOptions),
  current_mode_update: (session, update, _at, onDebug) => handleCurrentMode(session, update.currentModeId, onDebug),
  available_commands_update: (session, update) => ({ ...session, commands: sanitiseCommands(update.availableCommands) }),
};

function handleSessionUpdate(
  session: Session,
  update: SessionUpdate,
  at: number,
  onDebug?: (info: ModelDebugInfo) => void,
): Session {
  // Descriptor read, not `HANDLERS[key]`: outside data must not reach prototype keys.
  const handler = Object.getOwnPropertyDescriptor(SESSION_UPDATE_HANDLERS, update.sessionUpdate)
    ?.value as SessionUpdateHandler | undefined;
  if (handler === undefined) {
    // Every other variant (notice, compaction_update, compaction_summary_chunk, plan_update,
    // plan_removed, and any string the v1 union does not define at all) is out of the
    // implemented subset: ignored, not an error (spec "Unknown updates are ignored, not
    // errors").
    onDebug?.({ kind: "unknown_session_update", sessionUpdate: update.sessionUpdate });
    return session;
  }
  return handler(session, update, at, onDebug);
}

// -- Public reducer -------------------------------------------------------------------------------

type EventReducer<E extends ModelEvent = ModelEvent> = (
  session: Session,
  event: E,
  onDebug?: (info: ModelDebugInfo) => void,
) => Session;

function handleSessionCreated(session: Session, event: Extract<ModelEvent, { type: "session_created" }>, onDebug?: (info: ModelDebugInfo) => void): Session {
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
}

function handleSessionOpening(session: Session, event: Extract<ModelEvent, { type: "session_opening" }>): Session {
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
}

/** acp-tui's own notice (the session directory marker): not the agent's activity, so `replay`,
 *  as the resume marker; sanitised all the same. */
function handleClientNotice(session: Session, event: Extract<ModelEvent, { type: "client_notice" }>): Session {
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

function handlePromptSent(session: Session, event: Extract<ModelEvent, { type: "prompt_sent" }>): Session {
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

/** Archive-sourced turn open — no user item, just the lifecycle. A turn already open with a
 *  pending request keeps its tracking (a dropped stop must not silently unblock it); with
 *  nothing pending the prior stop was dropped, so the turn re-anchors to this start —
 *  otherwise the next turn_end's duration spans the dead turn too. */
function handleTurnStarted(session: Session, event: Extract<ModelEvent, { type: "turn_started" }>): Session {
  const prev = session.turn;
  const pending =
    prev !== null &&
    (prev.openPermissionToolCallIds.length > 0 || prev.openElicitationIds.length > 0);
  if (pending) {
    return { ...withOpenRequests(session, { ...prev, archive: true }), stopReason: null };
  }
  // a fresh archive turn — seal the dropped turn's live run too,
  // or the next id-less chunk concatenates into a dead turn's
  // item. The seal commits a reported plan like endTurn does —
  // a dropped stop must not lose the plan it already printed
  const sealed = commitPlanIfReported(finaliseLiveItems(session, event.at));
  return { ...withOpenRequests(sealed, emptyTurn(event.at, true)), stopReason: null };
}

function handlePromptResponse(session: Session, event: Extract<ModelEvent, { type: "prompt_response" }>): Session {
  // a turn anchored at epoch 0 (a stamp-less start row) would
  // render an epoch-sized duration — only a real start anchors
  const durationMs =
    session.turn && session.turn.startedAt > 0
      ? Math.max(0, event.at - session.turn.startedAt)
      : 0;
  const next = endTurn(session, event.at, {
    kind: "marker",
    markerKind: "turn_end",
    stopReason: event.stopReason,
    durationMs,
    usage: session.usage,
  });
  return { ...next, stopReason: event.stopReason };
}

function handlePromptError(session: Session, event: Extract<ModelEvent, { type: "prompt_error" }>): Session {
  const next = endTurn(session, event.at, null);
  return appendNoticeOrError(next, "error", event.message);
}

function handleAgentExited(session: Session, event: Extract<ModelEvent, { type: "agent_exited" }>): Session {
  const next = session.turn ? endTurn(session, event.at, null) : session;
  const withNotice = appendNoticeOrError(
    next,
    "notice",
    event.exitCode === null ? "agent exited" : `agent exited (code ${event.exitCode})`,
  );
  return { ...withNotice, connection: "disconnected" };
}

/** One entry per handled event type — adding a variant is a table row, not a switch arm. */
const EVENT_REDUCERS: {
  [E in ModelEvent as E["type"]]?: EventReducer<E>;
} = {
  session_created: handleSessionCreated,
  session_opening: handleSessionOpening,
  session_opened: (session, event, onDebug) => handleSessionOpened(session, event.response, onDebug),
  additional_directories_replaced: (session, event) => ({
    ...session,
    additionalDirectories: [...event.additionalDirectories],
  }),
  session_update: (session, event, onDebug) => handleSessionUpdate(session, event.update, event.at, onDebug),
  client_notice: handleClientNotice,
  prompt_sent: handlePromptSent,
  turn_started: handleTurnStarted,
  prompt_response: handlePromptResponse,
  prompt_error: handlePromptError,
  permission_opened: (session, event) => handlePermissionOpened(session, event.toolCallId, event.request, event.at),
  permission_answered: (session, event) =>
    closePermission(session, event.toolCallId, {
      type: "answered",
      optionId: event.optionId,
      optionKind: event.optionKind as PermissionOptionKind,
    }),
  permission_cancelled: (session, event) => closePermission(session, event.toolCallId, { type: "cancelled" }),
  permission_withdrawn: (session, event) => closePermission(session, event.toolCallId, { type: "withdrawn" }),
  elicitation_opened: (session, event) => openElicitation(session, event.elicitationId, event.at),
  elicitation_closed: (session, event) => closeElicitation(session, event.elicitationId),
  config_options_replaced: (session, event) => replaceConfigOptions(session, event.configOptions),
  legacy_model_selected: (session, event, onDebug) => handleLegacyModelSelected(session, event.modelId, onDebug),
  agent_exited: handleAgentExited,
};

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
  // Descriptor read, not `EVENT_REDUCERS[key]`: an arbitrary type string must not reach
  // prototype keys; an unknown event folds to the identity, same as the old default arm.
  const reducer = Object.getOwnPropertyDescriptor(EVENT_REDUCERS, event.type)
    ?.value as EventReducer | undefined;
  return reducer === undefined ? session : reducer(session, event, onDebug);
}
