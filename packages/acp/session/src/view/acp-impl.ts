/**
 * The `acp` pane impl (spec bro-q2edc, "Phase 2 — the seam") — the
 * vendored `acp-model` session behind the `PaneImpl` contract.
 *
 * The adapter shape is the spike's (`spike-feed.ts`): the archive is
 * a REPLAY of another client's session, so the feed opens with
 * `session_opening` (mode `load`) — every replay item carries
 * `origin: "replay"` — and `beginLive()` closes the envelope with
 * `session_opened`, after which the live tail lands as `origin:
 * "other"` (observed activity, the readonly posture). `turn stop`
 * rows map to `prompt_response` (the turn_end marker; duration 0 —
 * the archive never records prompt_sent); `turn start` maps to
 * `turn_started` — the lifecycle half only, never a fabricated user
 * message; permission rows map to `permission_opened`.
 *
 * Their session is immutable and delta-free, so `drain()` diffs the
 * item maps and emits our ops — a changed item re-projects whole.
 * Tool args are not on their items (their card shows the wire
 * title), so the feed stashes `rawInput` per toolCallId on the way
 * past — our `toolArg` keeps its exact header/body fidelity.
 */

import type { LoadSessionResponse, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import {
  createSession,
  type MarkerItem,
  type ModelEvent,
  type PermissionRecordItem,
  type PlanItem,
  reduce,
  type Session,
  type Item as TheirItem,
  type ToolCallItem,
} from '@broject/acp-model';
import type { ArchiveRow, PaneLed } from '../archive/index.ts';
import {
  dumpContent,
  dumpItems,
  type Item,
  MAX_ITEMS,
  type Op,
  type SideItem,
  type TextItem,
  type ToolItem,
  type ToolStatus,
} from '../model/items.ts';
import { isJudgeTurn, verdictOf } from '../model/verdict.ts';
import { fmtUsage, fmtWhen, headBy, isInternalBy, TimeGutter } from '../wire/fmt.ts';
import { planBox, type SessionUpdateLike, type ToolWire, toolArg } from '../wire/index.ts';
import { acpLine, lineText } from './acp-lines.ts';
import type { FoldPolicy, PaneImpl } from './impl.ts';

/** sessionUpdate kinds their reducer handles (items or absorbed
 *  session state — usage/mode/config/commands/info). Anything else
 *  hits their `default` arm and vanishes — those count into the
 *  `▸ N hidden` row the end-user filter owes the reader. */
const ITEM_UPDATES = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
  'session_info_update',
  'config_option_update',
  'current_mode_update',
  'available_commands_update',
]);

const at = (row: ArchiveRow): number => {
  const ts = row.ts;
  const ms = ts !== undefined ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/** One archive row → the ModelEvents it means (usually one; `turn
 *  start` maps to `turn_started` — `prompt_sent` would fabricate a
 *  user message the archive does not carry). */
function eventsOf(row: ArchiveRow): ModelEvent[] {
  const t = at(row);
  switch (row.kind) {
    case 'update':
      return row.update !== undefined
        ? [{ type: 'session_update', update: row.update as SessionUpdate, at: t }]
        : [];
    case 'turn':
      return turnEvents(row, t);
    case 'permission':
      return permissionEvents(row, t);
    default:
      return [];
  }
}

/** A turn row → its lifecycle events: `turn_started` on open,
 *  `prompt_response` (+ `prompt_error` on failure) on stop. */
const turnEvents = (row: ArchiveRow, t: number): ModelEvent[] => {
  if (row.phase === 'start') {
    // the archive's turn-open marker — `prompt_sent` would fabricate a
    // user message the journal does not carry; `turn_started` is the
    // lifecycle half only, but it is what lets the LED reach running.
    // A stamp-less start (t === 0) must not anchor the turn at epoch —
    // the matching stop would render an epoch-sized duration
    if (t === 0) return [];
    return [{ type: 'turn_started', at: t }];
  }
  if (row.phase !== 'stop') return [];
  const events: ModelEvent[] = [
    {
      type: 'prompt_response',
      stopReason: (row.stopReason ?? 'end_turn') as StopReason,
      at: t,
    },
  ];
  // a failed turn's error is NOT on prompt_response — the vendored
  // reducer only makes `turn_end` markers from it. `prompt_error`
  // yields the error marker that prints `── turn failed ──`.
  if (row.error !== undefined && row.error !== '') {
    events.push({ type: 'prompt_error', message: row.error, at: t });
  }
  return events;
};

/** A permission row → open + close events. The ASK opens the record;
 *  `phase: 'answer'` closes it. The headless driver's journal has
 *  ONE row that carries the verdict and no phase — for that shape
 *  the row opens AND closes, which is what keeps the archive's
 *  single-row permission working. */
const permissionEvents = (row: ArchiveRow, t: number): ModelEvent[] => {
  const toolCallId = (row.toolCallId ?? 'unknown') as never;
  const events: ModelEvent[] = [];
  if (row.phase !== 'answer') {
    events.push({
      type: 'permission_opened',
      toolCallId,
      request: {
        sessionId: 'archive' as never,
        toolCall: {
          toolCallId,
          title: row.title ?? 'permission',
          status: 'in_progress',
        },
        options: (row.options ?? []) as never,
      },
      at: t,
    });
  }
  const close = permissionClose(row, toolCallId, t);
  if (close !== undefined) events.push(close);
  return events;
};

/** The record's close event, or undefined when it stays open. ONLY
 *  an explicit answer closes the record. The headless driver's row
 *  carries a verdict TOO, but that verdict is the driver's, not the
 *  pane's — the archive's ask stays OPEN, which is what makes the
 *  pane say 'blocked · permission' (the row IS the pane's blocked
 *  signal, spec bro-l8wqu). */
const permissionClose = (row: ArchiveRow, toolCallId: never, t: number): ModelEvent | undefined => {
  const verdict = row.phase === 'answer' ? row.verdict : undefined;
  if (verdict === undefined || verdict === '') return undefined;
  if (verdict === 'cancelled') return { type: 'permission_cancelled', toolCallId, at: t };
  return {
    type: 'permission_answered',
    toolCallId,
    optionId: row.optionId ?? verdict,
    optionKind: (row.optionKind ??
      (verdict === 'approved' ? 'allow_once' : 'reject_once')) as never,
    at: t,
  };
};

/** Their tool status → ours (their 'cancelled' reads as our failed). */
const TOOL_STATUS: Record<string, ToolStatus> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};
const toolStatus = (s: string): ToolStatus => TOOL_STATUS[s] ?? 'live';

/** The fields every projection needs beyond the item itself — our
 *  numeric `id`, the feed's `args` rawInput stash, the fold policy
 *  (`folded` marks the pane's default; the dump path passes false —
 *  a dump is the full readout, the fold is pane state), and the
 *  birth row's `stamp`/`judge`/`by`. */
interface ProjCtx {
  id: number;
  args: ReadonlyMap<string, string>;
  folded: boolean;
  stamp?: string;
  judge?: boolean;
  by?: string;
}

/** Their content entries → our card content — text verbatim, diffs
 *  remapped to old/cur, a missing terminal noted by call id. */
const toolContentOf = (item: ToolCallItem): ToolItem['content'] => {
  const content: ToolItem['content'] = [];
  for (const c of item.content) {
    switch (c.type) {
      case 'text':
        content.push({ kind: 'text', text: c.text });
        break;
      case 'diff':
        content.push({
          kind: 'diff',
          path: c.path,
          old: c.oldText ?? undefined,
          cur: c.newText,
        });
        break;
      case 'terminal_unavailable':
        content.push({ kind: 'terminal', id: item.toolCallId });
        break;
    }
  }
  // Some agents answer output only via rawOutput — their view-model's
  // same fallback, projected into our content array.
  if (content.length === 0 && item.rawOutputText !== null) {
    content.push({ kind: 'text', text: item.rawOutputText });
  }
  return content;
};

/** The running-turn mode — `turn since <start>` when the clock is
 *  real, else the bare posture word. */
const runMode = (s: Session): string =>
  s.turn !== null && s.turn.startedAt > 0 ? `turn since ${fmtWhen(s.turn.startedAt)}` : 'turn';

/** One tool_call → our card. `arg` comes from the feed's rawInput
 *  stash — their item deliberately drops it. */
const toolItem = (item: ToolCallItem, ctx: ProjCtx): ToolItem => {
  const content = toolContentOf(item);
  const arg = ctx.args.get(item.toolCallId);
  return {
    id: ctx.id,
    kind: 'tool',
    toolCallId: item.toolCallId,
    title: item.title === '' ? (item.toolName ?? 'tool') : item.title,
    toolKind: item.toolKind ?? undefined,
    arg: arg === '' ? undefined : arg,
    status: toolStatus(item.toolStatus),
    bodyLanded: content.length > 0,
    collapsed: ctx.folded && content.length > 0,
    content,
    at: ctx.stamp,
    vi: item,
  };
};

const planItem = (item: PlanItem, id: number): SideItem => {
  const lines = ['── plan ──'];
  for (const e of item.entries) {
    lines.push(`  ${planBox(e.status)} ${e.content}`);
  }
  return { id, kind: 'note', text: lines.join('\n'), vi: item };
};

const OUTCOME_LABELS: Record<string, string> = {
  allow_once: 'allow once',
  allow_always: 'allow always',
  reject_once: 'reject once',
  reject_always: 'reject always',
};

const permissionItem = (item: PermissionRecordItem, id: number): SideItem => {
  const o = item.outcome;
  const label =
    o.type === 'answered'
      ? (OUTCOME_LABELS[o.optionKind] ?? o.optionKind)
      : o.type === 'withdrawn'
        ? 'withdrawn by agent'
        : o.type === 'pending'
          ? 'pending'
          : 'denied';
  // The options are the ask's own menu — a record that carries them
  // was asked OF A HUMAN, so the card says what is on the table
  // instead of pointing at a terminal that is not there. A record
  // without options is the headless driver's: the old wording stays.
  if (item.options.length > 0) {
    const menu = item.options.map((opt, i) => `${i + 1}) ${opt.name}`).join(' · ');
    const tail = o.type === 'pending' ? `awaiting your answer: ${menu}` : label;
    return {
      id,
      kind: 'permission',
      text: `── ⚠ permission ‹${item.title}› — ${tail} ──`,
      tone: 'warn',
      vi: item,
    };
  }
  return {
    id,
    kind: 'permission',
    text: `── ⚠ permission ‹${item.title}› — ${label} (headless driver; open a terminal in this workspace to handle interactively) ──`,
    tone: 'warn',
    vi: item,
  };
};

const markerItem = (item: MarkerItem, id: number): SideItem | undefined => {
  // turn_end markers emit no row — duration/ctx fold into the ▸
  // activity line at drain time (addendum 11)
  if (item.markerKind === 'turn_end') return undefined;
  return item.markerKind === 'error'
    ? { id, kind: 'turn', text: `── turn failed — ${item.text} ──`, tone: 'error', vi: item }
    : { id, kind: 'note', text: item.text, vi: item };
};

/** The stamp/by pair every projection shares — `by` absent when
 *  the birth row carried no origin. */
const projBase = (ctx: ProjCtx): { at?: string; by?: string } => ({
  at: ctx.stamp,
  ...(ctx.by !== undefined ? { by: ctx.by } : {}),
});

type Projector = (item: never, ctx: ProjCtx) => Item | undefined;

/** Everything the dump helpers share — the line sink, the order,
 *  the run/storm membership maps, the tool lookup, and the last
 *  ▸-tally index (a turn_end folds duration/ctx into its arg). */
interface DumpRun {
  out: string[];
  ord: readonly string[];
  memberGroup: ReadonlyMap<string, string>;
  storm: ReadonlyMap<string, string>;
  find: (toolCallId: string) => unknown;
  lastRun: number;
}

/** The kind dispatch — one projector per vendored item kind.
 *  `stamp`/`judge`/`by` come from the feed's birth-row records,
 *  `ctx.folded` carries the pane's fold policy (the dump path
 *  projects open). */
const PROJECTORS = new Map<TheirItem['kind'], Projector>([
  [
    'agent_message',
    (item: Extract<TheirItem, { kind: 'agent_message' }>, ctx) => ({
      id: ctx.id,
      kind: 'message',
      text: item.text,
      ...projBase(ctx),
      ...(ctx.judge === true ? { judge: true } : {}),
    }),
  ],
  // our model dims user_message chunks like thoughts — parity; no
  // `vi` — their line language has no user-bubble row here
  [
    'user_message',
    (item: Extract<TheirItem, { kind: 'user_message' }>, ctx) => ({
      id: ctx.id,
      kind: 'thought',
      text: item.text,
      ...projBase(ctx),
    }),
  ],
  [
    'thought',
    (item: Extract<TheirItem, { kind: 'thought' }>, ctx) => ({
      id: ctx.id,
      kind: 'thought',
      text: item.text,
      ...projBase(ctx),
      vi: item,
    }),
  ],
  [
    'tool_call',
    (item: ToolCallItem, ctx) => ({
      ...toolItem(item, ctx),
      ...(ctx.by !== undefined ? { by: ctx.by } : {}),
    }),
  ],
  ['plan', (item: PlanItem, ctx) => ({ ...planItem(item, ctx.id), ...projBase(ctx) })],
  [
    'permission_record',
    (item: PermissionRecordItem, ctx) => ({
      ...permissionItem(item, ctx.id),
      ...projBase(ctx),
    }),
  ],
  [
    'marker',
    (item: MarkerItem, ctx) => {
      const m = markerItem(item, ctx.id);
      return m === undefined ? undefined : { ...m, ...projBase(ctx) };
    },
  ],
]);

/** Their item → ours (numeric id assigned by the diff). */
const project = (item: TheirItem, ctx: ProjCtx): Item | undefined =>
  (PROJECTORS.get(item.kind) as ((i: TheirItem, c: ProjCtx) => Item | undefined) | undefined)?.(
    item,
    ctx
  );

/** Activity kinds — the members a `▸ N …` run line collapses.
 *  agent/user text, markers and prompts stay their own rows. */
const ACTIVITY: ReadonlySet<TheirItem['kind']> = new Set([
  'tool_call',
  'thought',
  'plan',
  'permission_record',
]);

/** Runs of ≥2 consecutive activity sids in session order →
 *  member sid → its run's leader (first sid). Internal-provenance
 *  sids never join — they collapse under the storm group instead
 *  (a conductor's tool call must not pad the agent's ▸ tally). */
const buildRuns = (
  order: readonly string[],
  items: ReadonlyMap<string, TheirItem>,
  internal?: ReadonlySet<string>
): Map<string, string> =>
  collectRuns(
    order,
    sid => {
      const item = items.get(sid);
      return item !== undefined && ACTIVITY.has(item.kind) && internal?.has(sid) !== true;
    },
    2
  );

/** Runs of consecutive internal sids in session order → member sid →
 *  its storm's leader (first sid). Unlike activity runs even ONE sid
 *  forms a storm — a lone judge probe still reads `▸ 1 internal
 *  call`, never a bare one-token reply (addendum 27). */
const buildStorms = (
  order: readonly string[],
  internal: ReadonlySet<string>
): Map<string, string> => collectRuns(order, sid => internal.has(sid), 1);

/** Session order → the consecutive member runs it contains. */
const splitRuns = (order: readonly string[], isMember: (sid: string) => boolean): string[][] => {
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const sid of order) {
    if (!isMember(sid)) {
      cur = [];
      continue;
    }
    if (cur.length === 0) groups.push(cur);
    cur.push(sid);
  }
  return groups;
};

/** Runs of ≥`minRun` consecutive member sids in session order →
 *  member sid → its run's leader (first sid). */
const collectRuns = (
  order: readonly string[],
  isMember: (sid: string) => boolean,
  minRun: number
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const run of splitRuns(order, isMember)) {
    const lead = run[0];
    if (run.length >= minRun && lead !== undefined) {
      for (const sid of run) out.set(sid, lead);
    }
  }
  return out;
};

/** The leader's consecutive internal members — the storm item's
 *  tally and expanded `runs` body. */
const stormMembers = (
  order: readonly string[],
  internal: ReadonlySet<string>,
  leader: string
): string[] => {
  const start = order.indexOf(leader);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start; i < order.length; i++) {
    const sid = order[i];
    if (sid === undefined || !internal.has(sid)) break;
    out.push(sid);
  }
  return out;
};

/** The leader's member items in order — the tally's parts and the
 *  expanded row's lines. */
const runMembers = (
  order: readonly string[],
  items: ReadonlyMap<string, TheirItem>,
  internal: ReadonlySet<string>,
  leader: string
): TheirItem[] => {
  const start = order.indexOf(leader);
  if (start < 0) return [];
  const out: TheirItem[] = [];
  for (let i = start; i < order.length; i++) {
    const sid = order[i];
    const item = items.get(sid ?? '');
    if (sid === undefined || internal.has(sid) || item === undefined || !ACTIVITY.has(item.kind))
      break;
    out.push(item);
  }
  return out;
};

/** The `by` label → the caller's short name — `acp provider 'X'`→X,
 *  `provider:X`→X, `conductor:X`→X. The turn block's origin label. */
const shortBy = (by: string | undefined): string | undefined => {
  if (by === undefined || by === '') return undefined;
  const m = /^acp provider '([^']+)'$/.exec(by) ?? /^provider:(.+)$/.exec(by);
  if (m !== null) return m[1];
  const c = /^conductor:(.+)$/.exec(by);
  return c !== null ? c[1] : by;
};

/** `N tool calls` plural-safe part labels, in first-seen order. */
const tally = (members: readonly TheirItem[]): string => {
  const names: Record<string, [string, string]> = {
    tool_call: ['tool call', 'tool calls'],
    thought: ['thought', 'thoughts'],
    plan: ['plan', 'plans'],
    permission_record: ['permission', 'permissions'],
  };
  const parts: string[] = [];
  for (const kind of Object.keys(names) as (keyof typeof names)[]) {
    const n = members.filter(m => m.kind === kind).length;
    if (n === 0) continue;
    const [one, many] = names[kind] ?? [kind, `${kind}s`];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(' · ');
};

/** The collapsed run as a ToolItem — `arg` carries the confirmed
 *  `N tool calls · N thought · Ns` tally, `runs` the members for the
 *  expanded body; it morphs in place when the run grows. */
interface RunStats {
  started?: number;
  ended?: number;
  live: boolean;
  failed: boolean;
}

/** The run's tool-call rollup — earliest start, latest end, any
 *  in-flight, any failed. */
const runStats = (members: readonly TheirItem[]): RunStats => {
  const t: RunStats = { live: false, failed: false };
  for (const m of members) {
    if (m.kind !== 'tool_call') continue;
    if (m.startedAt !== null) t.started = Math.min(t.started ?? m.startedAt, m.startedAt);
    if (m.endedAt !== null) t.ended = Math.max(t.ended ?? m.endedAt, m.endedAt);
    if (m.toolStatus === 'in_progress' || m.toolStatus === 'pending') t.live = true;
    if (m.toolStatus === 'failed') t.failed = true;
  }
  return t;
};

/** The ` · 12.3s` duration part — only when the whole run settled
 *  and the window is real. */
const runSecs = (t: RunStats): string => {
  const done = !t.live && t.started !== undefined && t.ended !== undefined && t.ended > t.started;
  if (!done) return '';
  return ` · ${(((t.ended ?? 0) - (t.started ?? 0)) / 1000).toFixed(1)}s`;
};

const runItem = (members: readonly TheirItem[], ctx: ProjCtx): ToolItem => {
  const t = runStats(members);
  const by = ctx.by !== undefined ? ` · ${ctx.by}` : '';
  return {
    id: ctx.id,
    kind: 'tool',
    toolCallId: `run:${ctx.id}`,
    title: 'activity',
    arg: `${tally(members)}${runSecs(t)}${by}`,
    status: t.live ? 'live' : t.failed ? 'failed' : 'completed',
    bodyLanded: true,
    collapsed: ctx.folded,
    content: [],
    at: ctx.stamp,
    ...(ctx.by !== undefined ? { by: ctx.by } : {}),
    runs: members,
  };
};

/** An internal error marker's row text — `── turn failed — by ·
 *  err ──`: inside a storm the origin isn't obvious from a lone
 *  banner, so it rides inline (the legacy impl's `✗ by · err`
 *  grammar). Real-agent failures keep the bare banner — their head
 *  already names the origin. */
const stormErrText = (item: { text: string }, by: string | undefined): string =>
  `── turn failed — ${by !== undefined && by !== '' ? `${by} · ` : ''}${item.text} ──`;

/** The collapsed internal storm — a ToolItem on the run grammar so
 *  the ▸/▾ row and its `│` member list ride the existing chrome.
 *  `calls` counts the members' turn markers (one per turn end —
 *  error markers included) plus one for a live in-flight turn; the
 *  origins list keeps the provenance visible at a glance. Error
 *  markers stay members AND still print their own `── turn failed ──`
 *  row — the tally counts them, the red row shows them (addendum 27). */
const stormItem = (
  memberSids: readonly string[],
  items: ReadonlyMap<string, TheirItem>,
  byMap: ReadonlyMap<string, string>,
  ctx: ProjCtx
): ToolItem => {
  const s = stormStats(memberSids, items, byMap);
  const org = stormOrg(s.origins);
  return {
    id: ctx.id,
    kind: 'tool',
    toolCallId: `storm:${ctx.id}`,
    title: 'internal',
    arg: `${s.calls} internal ${s.calls === 1 ? 'call' : 'calls'}${s.fails > 0 ? ` · ${s.fails} failed` : ''}${org !== '' ? ` · ${org}` : ''}`,
    status: s.fails > 0 ? 'failed' : 'completed',
    bodyLanded: true,
    collapsed: ctx.folded,
    content: [],
    at: ctx.stamp,
    ...(ctx.by !== undefined ? { by: ctx.by } : {}),
    runs: s.members,
  };
};

/** marker kind → the storm counter it bumps. A finished turn
 *  journals TWO markers — the end_turn plus, on failure, the
 *  error — so calls counts ends, not markers. */
const STORM_TALLY = new Map<string, 'calls' | 'fails'>([
  ['turn_end', 'calls'],
  ['error', 'fails'],
]);

/** The ` · a, b +2` origin clause — up to three first-seen origins,
 *  the rest counted. */
const stormOrg = (origins: readonly string[]): string =>
  origins.length <= 3
    ? origins.join(', ')
    : `${origins.slice(0, 2).join(', ')} +${origins.length - 2}`;

interface StormTally {
  members: TheirItem[];
  origins: string[];
  calls: number;
  fails: number;
}

/** A prompt's dump lines — `▸ ` per text line, or the unavailable
 *  marker when the journal carried none. */
const promptRows = (text: string): string[] =>
  text === '' ? ['▸ prompt unavailable'] : text.split('\n').map(l => `▸ ${l}`);

const pushOnce = (list: string[], s: string): void => {
  if (!list.includes(s)) list.push(s);
};

/** One member sid's contribution — its first-seen origin, the item,
 *  and the marker kind's tally bump. */
const stormMember = (
  sid: string,
  items: ReadonlyMap<string, TheirItem>,
  byMap: ReadonlyMap<string, string>,
  t: StormTally
): void => {
  const o = byMap.get(sid);
  if (o !== undefined && o !== '') pushOnce(t.origins, o);
  const m = items.get(sid);
  if (m === undefined) return;
  t.members.push(m);
  const tally = m.kind === 'marker' ? STORM_TALLY.get(m.markerKind) : undefined;
  if (tally !== undefined) t[tally]++;
};

/** The storm's rollup — member items, the turn-call tally (turn_end
 *  markers plus a live in-flight turn), failures, and the first-seen
 *  origin list. */
const stormStats = (
  memberSids: readonly string[],
  items: ReadonlyMap<string, TheirItem>,
  byMap: ReadonlyMap<string, string>
): StormTally => {
  const t: StormTally = { members: [], origins: [], calls: 0, fails: 0 };
  for (const sid of memberSids) stormMember(sid, items, byMap, t);
  // a trailing non-marker member = a turn still in flight
  const last = t.members[t.members.length - 1];
  if (last !== undefined && last.kind !== 'marker') t.calls++;
  return t;
};

/** The vendored session behind the seam — fold-by-default, per the
 *  vendored view-model's baseline (`expanded(item)` starts false). */
export class AcpImpl implements PaneImpl {
  readonly name = 'acp';
  readonly fold: FoldPolicy = 'folded';
  private session: Session = reduce(createSession(), {
    type: 'session_opening',
    mode: 'load',
    sessionId: 'archive' as never,
    cwd: '/archive',
    at: 0,
  });
  /** Last drained snapshot — the diff's baseline. */
  private prev: ReadonlyMap<string, TheirItem> = new Map();
  /** Their string ids → our numeric item ids. */
  private readonly ids = new Map<string, number>();
  private nextId = 1;
  /** Emitted ids in append order — the eviction frontier. */
  private readonly emitted: number[] = [];
  /** toolCallId → rawInput arg text, stashed at feed time. */
  private readonly args = new Map<string, string>();
  /** Their sid → the row's `ts` at item birth — the gutter stamp. */
  private readonly tsMap = new Map<string, string>();
  /** Their sid → the row's `by` at item birth — the turn's origin
   *  (provider/conductor), folded into ▸ lines and verdict badges. */
  private readonly byMap = new Map<string, string>();
  /** The shell's context — agent id + worktree for the feed header. */
  private ctx: { worktree?: string; agent?: string } = {};
  /** The feed header item — emitted once the first row lands, then
   *  text-patched as provider/model arrive. */
  private headerId: number | undefined;
  private headerText = '';
  /** The first row's ts — the session's launch stamp. */
  private launchTs: string | undefined;
  /** The last emitted activity item — a turn_end's duration/ctx
   *  folds into its arg instead of a standalone row (addendum 11). */
  private lastActivity: { id: number; arg: string } | undefined;
  /** The session's provider label — first non-conductor `by` seen. */
  private provider: string | undefined;
  /** Their sids born under a judge-labelled turn — the reply text
   *  classifies as a verdict control at render. */
  private readonly judgeSids = new Set<string>();
  private judgeNow = false;
  /** Their sid → currently a run's leader — solo→group morphs are
   *  re-projections, not silent card swaps. */
  private readonly grouped = new Map<string, boolean>();
  /** Unknown sessionUpdates dropped by their reducer — the `▸ N
   *  hidden` row's count (hiddenId pins the one growing item). */
  private hidden = 0;
  private hiddenShown = 0;
  private hiddenId: number | undefined;
  /** Prompt items by feed position — drain() emits them inline; the
   *  dump interleaves them at `pos` (the session-order length when
   *  the row landed) so per-turn prompts stay chronological. */
  private readonly prompts: { pos: number; item: TextItem }[] = [];
  /** The separator layer — time heads/days as rows (addendum 25). */
  private readonly gutter = new TimeGutter();
  /** The open turn's origin — sids born under it head their group. */
  private curBy: string | undefined;
  /** The current turn's `shortBy` — update rows carry no `by`, so
   *  their sids inherit the turn's provenance for the storm tally
   *  and the `· origin` error prefixes. */
  private curShortBy: string | undefined;
  /** Inside an internal-provenance turn (conductor/provider/transport)
   *  — update rows carrying no `by` inherit it (addendum 27). */
  private curInternal = false;
  /** Sids born from internal rows — consecutive runs collapse into
   *  `▸ N internal calls` storm items at drain. */
  private readonly internalSids = new Set<string>();
  /** sid → is the storm's leader — leadership flips re-project like
   *  run grouping does. */
  private readonly stormLeads = new Map<string, boolean>();
  /** The last turn stop's journal ts — the "idle since" stamp the
   *  verdict mode paints (a silent agent's idle clock starts at its
   *  last closed turn, not at pane open). */
  private lastStopTs: string | undefined;
  /** The newest journal ts seen at all — the disconnect verdict's
   *  stand-in for "entered this state at" (an exit has no dedicated
   *  stamp; the last row before it is the closest truth). */
  private lastActivityTs: string | undefined;
  /** The ts of the row that opened the current requires_action
   *  posture — the permission clock's start. Rows that keep the
   *  ask open (tool updates, chunks) must not move it. */
  private actionTs: string | undefined;
  private lastStopError = false;
  /** leader sid → the `origin|error` keys its storm already rowed —
   *  N identical failures print ONE `── turn failed ──` and stay
   *  members (the tally still counts every one). */
  private readonly stormErrSeen = new Map<string, Set<string>>();
  /** Their sid → the turn origin at item birth (update rows carry no
   *  `by`; the turn's `by` is on the start row). */
  private readonly sidBy = new Map<string, string>();
  private ops: Op[] = [];

  /** The shell's context — agent/worktree for the feed header. */
  setContext(ctx: { worktree?: string; agent?: string }): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  feed(row: ArchiveRow): void /* NOSONAR typescript:S3776 */ {
    this.launchTs ??= row.ts;
    if (row.ts !== undefined) this.lastActivityTs = row.ts;
    // the provider label is any `acp provider 'X'`/`provider:X` by —
    // conductor rows name the orchestrator, not the model
    if (row.by !== undefined && /^(?:acp provider|provider:)/.test(row.by)) {
      this.provider ??= shortBy(row.by);
    }
    if (row.kind === 'prompt') {
      // an internal probe's question never paints the user card —
      // the storm batch owns its turn's rows end to end
      if (isInternalBy(row.by)) {
        this.curInternal = true;
        return;
      }
      this.curInternal = false;
      // the prompt row marks its turn — a typed-preamble body (or a
      // judge `by`) labels the reply for the verdict classifier
      this.judgeNow = isJudgeTurn(row.text, row.by);
      this.curBy = headBy(row.by);
      this.curShortBy = shortBy(row.by);
      const id = this.nextId++;
      const item: TextItem = {
        id,
        kind: 'prompt',
        text: row.text ?? '',
        at: row.ts,
        ...(row.by !== undefined ? { by: shortBy(row.by) } : {}),
      };
      this.emitted.push(id);
      this.gutter.start(row.by);
      for (const text of this.gutter.tick(row.ts)) this.emitTime(this.ops, text, row.ts);
      this.ops.push({ op: 'append', item });
      this.prompts.push({ pos: this.session.order.length, item });
      return;
    }
    if (row.kind === 'turn') {
      if (row.phase === 'start') {
        this.judgeNow = isJudgeTurn(undefined, row.by);
        this.curBy = headBy(row.by);
        this.curShortBy = shortBy(row.by);
        this.curInternal = isInternalBy(row.by);
      } else if (row.phase === 'stop') {
        this.judgeNow = false;
        this.lastStopTs = row.ts;
        // a failed stop row is the archive's 'turn error' — the LED
        // must not read idle over a crashed turn
        this.lastStopError = row.error !== undefined && row.error !== '';
      }
    }
    // the arg stash — their items drop rawInput, our header wants it
    if (row.kind === 'update' && row.update !== undefined) {
      const u = row.update as SessionUpdateLike & { toolCallId?: string };
      if (!ITEM_UPDATES.has(u.sessionUpdate)) this.hidden++;
      if (
        (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
        typeof u.toolCallId === 'string'
      ) {
        const kind =
          typeof (u as { kind?: string }).kind === 'string'
            ? ((u as { kind?: string }).kind as string)
            : undefined;
        const arg = toolArg(u as unknown as ToolWire, kind);
        if (arg !== undefined) this.args.set(u.toolCallId, arg);
      }
    }
    const wasAction = this.session.state === 'requires_action';
    const orderLen = this.session.order.length;
    for (const ev of eventsOf(row)) {
      this.session = reduce(this.session, ev);
    }
    // the blocked clock starts when the ask lands — a stamp-less
    // entry degrades to the bare 'permission' mode
    if (!wasAction && this.session.state === 'requires_action') {
      this.actionTs = row.ts;
    }
    // birth stamps ride the row that produced the item — order is
    // append-only, so born sids are the tail slice
    const internal =
      row.by !== undefined && row.by !== '' ? isInternalBy(row.by) : this.curInternal;
    const ord = this.session.order;
    for (let i = orderLen; i < ord.length; i++) {
      const sid = ord[i];
      if (sid === undefined) continue;
      if (internal) this.internalSids.add(sid);
      if (row.ts !== undefined) this.tsMap.set(sid, row.ts);
      // a by-less row inherits its turn's provenance — the storm
      // tally and error prefixes need it on every member sid
      const by = row.by !== undefined ? (shortBy(row.by) ?? row.by) : this.curShortBy;
      if (by !== undefined) this.byMap.set(sid, by);
      if (this.curBy !== undefined) this.sidBy.set(sid, this.curBy);
      if (this.judgeNow) this.judgeSids.add(sid);
    }
    // the stop's marker sid was born internal — the flag clears only
    // after the birth loop ran (addendum 27)
    if (row.kind === 'turn' && row.phase === 'stop') this.curInternal = false;
  }

  beginLive(): void {
    if (!this.session.replaying) return;
    this.session = reduce(this.session, {
      type: 'session_opened',
      response: {} as LoadSessionResponse,
      at: 0,
    });
  }

  /** Session states → the rowVerdict-shaped verdict the shell
   *  reports: replay pumps read working, a closed connection is
   *  blocked, requires_action is the permission posture. */
  get verdict(): { led: PaneLed; mode: string } | undefined {
    const s = this.session;
    if (s.replaying) return { led: { state: 'working' }, mode: 'replaying' };
    if (s.connection === 'disconnected') {
      return {
        led: { state: 'blocked' },
        mode: this.since('agent exited', this.lastActivityTs ?? this.lastStopTs),
      };
    }
    if (s.state === 'requires_action') {
      return { led: { state: 'blocked' }, mode: this.since('permission', this.actionTs) };
    }
    if (s.state === 'running') return { led: { state: 'working' }, mode: runMode(s) };
    return this.idleVerdict(s);
  }

  /** `base · since <when>` — terminal postures carry the status-entry
   *  stamp; "since" is the question a finished/blocked row must answer
   *  (a live turn's clock is its own startedAt, already painted). */
  private since(base: string, ts: string | undefined): string {
    const when = ts === undefined ? '' : fmtWhen(ts);
    return when === '' ? base : `${base} · since ${when}`;
  }

  /** The settled-state verdict — a failed stop is blocked, a stamped
   *  stop reports its completion time, a stamp-less one has no honest
   *  clock (last activity is a mid-turn row, not the completion). */
  private idleVerdict(s: Session): { led: PaneLed; mode: string } {
    if (this.lastStopError) {
      return { led: { state: 'blocked' }, mode: this.since('turn error', this.lastStopTs) };
    }
    let mode = 'idle';
    if (this.lastStopTs !== undefined) mode = `since ${fmtWhen(this.lastStopTs)}`;
    else if (s.stopReason !== null) mode = 'turn complete';
    return { led: { state: 'idle' }, mode };
  }

  /** Diff the session against the last drain — every changed item
   *  re-projects whole; order is append-only per their reducer.
   *  Runs of ≥2 consecutive activity items collapse into ONE
   *  `▸ N tool calls · …` group item (the confirmed live density) —
   *  the run's leader keeps its slot and morphs in place when the
   *  second member lands. */
  /** The birth-row records → a ProjCtx for `project`/`runItem`/`stormItem`. */
  private projCtx(sid: string, id: number): ProjCtx {
    return {
      id,
      args: this.args,
      folded: true,
      stamp: this.tsMap.get(sid),
      judge: this.judgeSids.has(sid),
      by: this.byMap.get(sid),
    };
  }

  /** The sid's current projection — the storm tally, the run tally,
   *  or the item's own row. */
  private projectNext(
    sid: string,
    item: TheirItem,
    id: number,
    group: { members?: TheirItem[]; stormSids?: string[] }
  ): Item | undefined {
    const ctx = this.projCtx(sid, id);
    if (group.stormSids !== undefined)
      return stormItem(group.stormSids, this.session.items, this.byMap, ctx);
    if (group.members !== undefined) return runItem(group.members, ctx);
    return project(item, ctx);
  }

  /** The session model id — the legacy model state first, then a
   *  `model` config option (the vendored UI's own preference). */
  private sessionModel(): string | undefined {
    const s = this.session as { models?: { currentModelId?: string } | null };
    if (typeof s.models?.currentModelId === 'string') return s.models.currentModelId;
    const opts = (
      this.session as {
        configOptions?: readonly { id?: string; name?: string; currentValue?: unknown }[];
      }
    ).configOptions;
    const m = opts?.find(o => /model/i.test(String(o.id ?? o.name ?? '')));
    const v = m?.currentValue;
    return typeof v === 'string' && v !== '' ? v : undefined;
  }

  /** The feed header — `▸ agent · provider · model · cwd · launched`.
   *  Emitted once on the first drain with data, then text-patched as
   *  provider/model arrive (never evicted — the pane's title). */
  private emitHeader(ops: Op[]): void {
    if (this.launchTs === undefined) return;
    const parts = [
      this.ctx.agent,
      this.provider,
      this.sessionModel(),
      this.ctx.worktree,
      `launched ${this.launchTs.slice(5, 16).replace('T', ' ')}`,
    ].filter((p): p is string => p !== undefined && p !== '');
    const text = `▸ ${parts.join(' · ')}`;
    if (this.headerId === undefined) {
      this.headerId = this.nextId++;
      this.headerText = text;
      ops.unshift({ op: 'append', item: { id: this.headerId, kind: 'header', text } });
    } else if (text !== this.headerText) {
      this.headerText = text;
      ops.unshift({ op: 'text', id: this.headerId, text });
    }
  }

  /** A `── HH:MM · by ──` or `── D Mmm ──` separator op — ids ride
   *  the same counter and eviction frontier as items. */
  private emitTime(ops: Op[], text: string, ts: string | undefined): void {
    const id = this.nextId++;
    this.emitted.push(id);
    ops.push({ op: 'append', item: { id, kind: 'time', text, at: ts } });
  }

  /** A turn_end marker → an arg patch on the latest ▸ activity item:
   *  ` · 45.4s · ctx 38k/200k` appended once, no standalone row. */
  private endFold(item: Extract<MarkerItem, { markerKind: 'turn_end' }>, ops: Op[]): void {
    const last = this.lastActivity;
    if (last === undefined) return;
    const dur = item.durationMs > 0 ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : '';
    const u = item.usage;
    const ctx =
      u !== null && u !== undefined && u.size > 0 ? ` · ctx ${fmtUsage(u.used, u.size)}` : '';
    const arg = `${last.arg}${dur}${ctx}`;
    last.arg = arg;
    ops.push({ op: 'tool', item: { id: last.id, arg } });
  }

  /** Emit the session-level ops that never touch the item map —
   *  the feed header's text patches (model/config/context changes)
   *  and the `▸ N hidden` tally for updates their reducer drops.
   *  These ride every drain: keying them on `items` identity would
   *  drop a metadata-only or hidden-only batch whole (bro-rszje). */
  drain(): Op[] {
    const ops = this.ops;
    this.ops = [];
    this.emitHeader(ops);
    const items = this.session.items;
    if (items !== this.prev) this.diffItems(ops, items);
    // the end-user filter's account of what the model dropped —
    // one growing tally row, not per-kind noise
    if (this.hidden > this.hiddenShown) {
      const text = `▸ ${this.hidden} hidden`;
      if (this.hiddenId === undefined) {
        this.hiddenId = this.nextId++;
        this.emitted.push(this.hiddenId);
        ops.push({ op: 'append', item: { id: this.hiddenId, kind: 'note', text } });
      } else {
        ops.push({ op: 'text', id: this.hiddenId, text });
      }
      this.hiddenShown = this.hidden;
    }
    const over = this.emitted.length - MAX_ITEMS;
    if (over > 0) {
      ops.push({ op: 'evict', ids: this.emitted.splice(0, over) });
    }
    return ops;
  }

  /** Diff the session's item map against the last drain — every
   *  changed item re-projects whole; order is append-only per their
   *  reducer. Runs of ≥2 consecutive activity items collapse into
   *  ONE `▸ N tool calls · …` group item (the confirmed live
   *  density) — the run's leader keeps its slot and morphs in place
   *  when the second member lands. */
  private diffItems(
    ops: Op[],
    items: ReadonlyMap<string, TheirItem>
  ): void /* NOSONAR typescript:S3776 */ {
    const memberGroup = buildRuns(this.session.order, items, this.internalSids);
    const storm = buildStorms(this.session.order, this.internalSids);
    // a changed member dirties its leader's tally — the group
    // re-projects even when the leader's own item is identical
    const dirty = new Set<string>();
    for (const sid of this.session.order) {
      const leader = memberGroup.get(sid) ?? storm.get(sid);
      if (leader !== undefined && leader !== sid && this.prev.get(sid) !== items.get(sid)) {
        dirty.add(leader);
      }
    }
    for (const sid of this.session.order) {
      const item = items.get(sid);
      if (item === undefined) continue;
      // an error marker inside a storm keeps its own row — the tally
      // counts it AND the red `── turn failed ──` shows it, once per
      // distinct (origin, error) per storm; repeats stay members only
      const errorMarker = item.kind === 'marker' && item.markerKind === 'error';
      const stormLeader = storm.get(sid);
      if (stormLeader !== undefined && stormLeader !== sid) {
        let emitErr = false;
        if (errorMarker) {
          const key = `${this.byMap.get(sid) ?? ''}|${item.text}`;
          let seen = this.stormErrSeen.get(stormLeader);
          if (seen === undefined) {
            seen = new Set();
            this.stormErrSeen.set(stormLeader, seen);
          }
          if (!seen.has(key)) {
            seen.add(key);
            emitErr = true;
          }
        }
        if (!emitErr) {
          const gid = this.ids.get(stormLeader);
          if (gid !== undefined) this.ids.set(sid, gid);
          continue;
        }
      }
      const leader = memberGroup.get(sid);
      if (leader !== undefined && leader !== sid) {
        // a member never owns a row — route its id at the group so
        // a stray update resolves to the tally item
        const gid = this.ids.get(leader);
        if (gid !== undefined) this.ids.set(sid, gid);
        continue;
      }
      const was = this.prev.get(sid);
      const nowGrouped = memberGroup.has(sid);
      const nowStorm = stormLeader === sid;
      const members = nowGrouped
        ? runMembers(this.session.order, items, this.internalSids, sid)
        : undefined;
      const stormSids = nowStorm
        ? stormMembers(this.session.order, this.internalSids, sid)
        : undefined;
      const changed =
        was !== item ||
        nowGrouped !== (this.grouped.get(sid) ?? false) ||
        nowStorm !== (this.stormLeads.get(sid) ?? false) ||
        dirty.delete(sid);
      this.grouped.set(sid, nowGrouped);
      this.stormLeads.set(sid, nowStorm);
      if (was === item && !changed) continue;
      // turn_end emits no row — duration/ctx fold into the latest ▸
      // activity line's arg (addendum 11). A storm LEADER is the
      // exception: its own marker is silent but the storm item it
      // heads is not — without the escape a storm opening on a
      // clean end never emits its tally row
      if (item.kind === 'marker' && item.markerKind === 'turn_end' && !nowStorm) {
        this.endFold(item, ops);
        continue;
      }
      let id = this.ids.get(sid);
      if (was === undefined) {
        id = this.nextId++;
        this.ids.set(sid, id);
        this.emitted.push(id);
        const next = this.projectNext(sid, item, id, { members, stormSids });
        if (next === undefined) continue;
        // an internal failure's banner carries its origin — inside a
        // storm the head can't be trusted to name it
        if (
          errorMarker &&
          this.internalSids.has(sid) &&
          next.kind === 'turn' &&
          item.kind === 'marker'
        ) {
          next.text = stormErrText(item, this.byMap.get(sid));
        }
        // the separator layer pays first — the birth row's minute and
        // the turn origin at birth (a drain batch can span turns)
        this.gutter.start(this.sidBy.get(sid));
        for (const text of this.gutter.tick(this.tsMap.get(sid))) {
          this.emitTime(ops, text, this.tsMap.get(sid));
        }
        ops.push({ op: 'append', item: next });
        // a storm LED by an error marker — the failure row rides
        // right after the ▸ tally (member dedup can't catch the
        // leader: it IS the storm's slot)
        if (stormSids !== undefined && errorMarker) {
          const key = `${this.byMap.get(sid) ?? ''}|${item.text}`;
          let seen = this.stormErrSeen.get(sid);
          if (seen === undefined) {
            seen = new Set();
            this.stormErrSeen.set(sid, seen);
          }
          if (!seen.has(key)) {
            seen.add(key);
            const row = project(item, this.projCtx(sid, this.nextId++));
            if (row !== undefined && row.kind === 'turn' && item.kind === 'marker') {
              row.text = stormErrText(item, this.byMap.get(sid));
            }
            if (row !== undefined) {
              this.emitted.push(row.id);
              ops.push({ op: 'append', item: row });
            }
          }
        }
        if (members !== undefined && next.kind === 'tool') {
          this.lastActivity = { id, arg: next.arg ?? '' };
        }
        continue;
      }
      if (id === undefined) continue;
      const next = this.projectNext(sid, item, id, { members, stormSids });
      if (next === undefined) continue;
      if (members !== undefined && next.kind === 'tool') {
        this.lastActivity = { id, arg: next.arg ?? '' };
      }
      if (next.kind === 'tool') {
        // a bare tool op — `collapsed` omitted so the fold keeps the
        // user's toggle across updates
        const { collapsed: _c, ...rest } = next;
        ops.push({ op: 'tool', item: rest });
      } else {
        ops.push({ op: 'text', id, text: next.text });
      }
    }
    this.prev = items;
  }

  /** The whole projection, formatted — the `--dump` readout. Items
   *  with a vendored line print THAT row (the pane's own language);
   *  tools keep their body below it (a dump is the full readout). */
  dump(): string[] {
    const out: string[] = [];
    // the feed header — same block the pane renders first
    this.emitHeader([]);
    if (this.headerText !== '') out.push(this.headerText);
    const toolsByCall = new Map<string, TheirItem>();
    for (const sid of this.session.order) {
      const item = this.session.items.get(sid);
      if (item?.kind === 'tool_call') toolsByCall.set(item.toolCallId, item);
    }
    const find = (toolCallId: string): unknown => toolsByCall.get(toolCallId);
    // prompt items interleave at the order position they landed —
    // per-turn prompts stay chronological through the readout
    const pi = { n: 0 };
    const ord = this.session.order;
    const d: DumpRun = {
      out,
      ord,
      memberGroup: buildRuns(ord, this.session.items, this.internalSids),
      storm: buildStorms(ord, this.internalSids),
      find,
      lastRun: -1,
    };
    for (let i = 0; i < ord.length; i++) {
      this.emitDumpPrompts(out, i, pi);
      this.dumpSid(d, i);
    }
    this.emitDumpPrompts(out, Number.MAX_SAFE_INTEGER, pi);
    if (this.hidden > 0) out.push(`▸ ${this.hidden} hidden`);
    return out;
  }

  /** Every prompt whose order position passed — its ▸ lines, or the
   *  unavailable marker. `pi` is the shared cursor across calls. */
  private emitDumpPrompts(out: string[], pos: number, pi: { n: number }): void {
    while (pi.n < this.prompts.length && (this.prompts[pi.n]?.pos ?? 0) <= pos) {
      const p = this.prompts[pi.n++];
      if (p !== undefined) out.push(...promptRows(p.item.text));
    }
  }

  /** One order position of the readout — membership skip, the id
   *  slot, then the row kind's emitter. */
  private dumpSid(d: DumpRun, i: number): void {
    const sid = d.ord[i];
    const item = sid === undefined ? undefined : this.session.items.get(sid);
    if (item === undefined || sid === undefined) return;
    if (this.dumpSkips(d, sid, item)) return;
    this.dumpEmit(d, sid, item, this.dumpItemId(sid));
  }

  /** Membership dedup — a storm member stays silent unless it is an
   *  error marker; a run member always does. */
  private dumpSkips(d: DumpRun, sid: string, item: TheirItem): boolean {
    if (this.stormSkips(d, sid, item)) return true;
    const leader = d.memberGroup.get(sid);
    return leader !== undefined && leader !== sid;
  }

  /** A storm member emits no row of its own — except the error
   *  marker, whose banner can't be attributed from the ▸ tally. */
  private stormSkips(d: DumpRun, sid: string, item: TheirItem): boolean {
    const stormLeader = d.storm.get(sid);
    return stormLeader !== undefined && stormLeader !== sid && !this.isStormErr(sid, item);
  }

  /** True for an internal error marker — its banner can't be
   *  attributed inside a storm, so it prints its origin inline. */
  private isStormErr(
    sid: string,
    item: TheirItem
  ): item is Extract<MarkerItem, { markerKind: 'error' }> {
    return item.kind === 'marker' && item.markerKind === 'error' && this.internalSids.has(sid);
  }

  /** The sid's numeric slot — minted on first sight. */
  private dumpItemId(sid: string): number {
    let id = this.ids.get(sid);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(sid, id);
    }
    return id;
  }

  /** The row kind's emitter — turn_end folds, run/storm leaders
   *  tally, the rest is an ordinary row. */
  private dumpEmit(d: DumpRun, sid: string, item: TheirItem, id: number): void {
    if (item.kind === 'marker' && item.markerKind === 'turn_end') {
      this.dumpTurnEnd(item, d);
      return;
    }
    if (d.memberGroup.get(sid) === sid) {
      d.lastRun = this.dumpRun(
        d,
        sid,
        runMembers(d.ord, this.session.items, this.internalSids, sid),
        id
      );
      return;
    }
    if (d.storm.get(sid) === sid) {
      this.dumpStorm(d, sid, stormMembers(d.ord, this.internalSids, sid), id);
      return;
    }
    this.dumpRow(d, sid, item, id);
  }

  /** Birth-row records → a ProjCtx for the dump projection
   *  (folded=false — a dump is the full readout, the fold is pane
   *  state; `stamp` stays unset like the old dump calls for run and
   *  storm rows). */
  private dumpCtx(sid: string, id: number, stamp?: string): ProjCtx {
    return {
      id,
      args: this.args,
      folded: false,
      stamp,
      judge: this.judgeSids.has(sid),
      by: this.byMap.get(sid),
    };
  }

  /** A turn_end marker → ` · 45.4s · ctx 38k/200k` patched onto the
   *  latest ▸ tally line. */
  private dumpTurnEnd(item: Extract<MarkerItem, { markerKind: 'turn_end' }>, d: DumpRun): void {
    if (d.lastRun < 0) return;
    const dur = item.durationMs > 0 ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : '';
    const u = item.usage;
    const ctx =
      u !== null && u !== undefined && u.size > 0 ? ` · ctx ${fmtUsage(u.used, u.size)}` : '';
    d.out[d.lastRun] = `${d.out[d.lastRun]}${dur}${ctx}`;
  }

  /** One member's one-liner under the │ gutter — the item's acpLine
   *  at dump width, or its bare kind when the line is empty. */
  private dumpMemberLine(d: DumpRun, m: TheirItem): string {
    const ml = lineText(
      acpLine(m, {
        width: 116,
        frame: 0,
        findTool: d.find,
        arg: m.kind === 'tool_call' ? this.args.get(m.toolCallId) : undefined,
      })
    );
    return `│  ${ml === '' ? m.kind : ml.trimEnd()}`;
  }

  /** The ▸-tally line; members hang under it in the │ gutter.
   *  Returns the out index of the tally for turn_end folds. */
  private dumpRun(d: DumpRun, sid: string, members: TheirItem[], id: number): number {
    const n = d.out.length;
    d.out.push(`▸ ${runItem(members, this.dumpCtx(sid, id)).arg}`);
    for (const m of members) d.out.push(this.dumpMemberLine(d, m));
    return n;
  }

  /** The ▸-storm line — same grammar; internal members show their
   *  own one-liners under the gutter. */
  private dumpStorm(d: DumpRun, sid: string, memberSids: string[], id: number): void {
    const st = stormItem(memberSids, this.session.items, this.byMap, this.dumpCtx(sid, id));
    d.out.push(`▸ ${st.arg}`);
    for (const msid of memberSids) {
      const m = this.session.items.get(msid);
      if (m !== undefined) d.out.push(this.dumpMemberLine(d, m));
    }
  }

  /** The ordinary rows — the acpLine one-liner (plus a tool's body),
   *  else the projection's own dump (verdict controls included). */
  private dumpRow(d: DumpRun, sid: string, item: TheirItem, id: number): void {
    const line = this.dumpRowLine(d, sid, item);
    if (line !== '') {
      d.out.push(line);
      this.dumpToolBody(d, sid, item, id);
      return;
    }
    this.dumpProjected(d, sid, item, id);
  }

  /** The sid's one-liner — an internal error marker prints its
   *  origin inline (inside a storm the lone banner can't be
   *  attributed otherwise); every other row is its acpLine. */
  private dumpRowLine(d: DumpRun, sid: string, item: TheirItem): string {
    if (this.isStormErr(sid, item)) {
      return stormErrText(item, this.byMap.get(sid));
    }
    return lineText(
      acpLine(item, {
        width: 120,
        frame: 0,
        findTool: d.find,
        arg: item.kind === 'tool_call' ? this.args.get(item.toolCallId) : undefined,
      })
    );
  }

  /** A tool call's body under the │ gutter — the full readout. */
  private dumpToolBody(d: DumpRun, sid: string, item: TheirItem, id: number): void {
    if (item.kind !== 'tool_call') return;
    const ctx = this.dumpCtx(sid, id, this.tsMap.get(sid));
    for (const l of dumpContent(toolItem(item, ctx).content)) {
      d.out.push(`│  ${l}`);
    }
  }

  /** The projection fallback — judge replies print the verdict
   *  control, not the JSON wall (the same shape classification the
   *  pane's VerdictRow uses; the badge is the call's model/provider,
   *  never a brand literal). */
  private dumpProjected(d: DumpRun, sid: string, item: TheirItem, id: number): void {
    const p = project(item, this.dumpCtx(sid, id, this.tsMap.get(sid)));
    if (p === undefined) return;
    if ('text' in p) {
      const v = verdictOf(p.text);
      if (v !== undefined) {
        d.out.push(`⛨ ${v.model ?? p.by ?? 'verdict'} · ${v.summary}`);
        for (const [q, f] of v.fields) d.out.push(`   ${q} ${f}`);
        return;
      }
    }
    d.out.push(...dumpItems([p]));
  }

  /** The item's full raw text for Ctrl+C — the impl's line language
   *  at copy width (no display clip): a run emits every member's
   *  line, a tool its one-liner + full body, a verdict its control
   *  text, everything else its raw text. */
  copyText(item: Item): string {
    const line = (vi: unknown): string =>
      lineText(acpLine(vi, { width: 400, frame: 0, findTool: () => undefined }));
    if ('runs' in item && item.runs !== undefined) return copyRuns(item, line);
    if ('vi' in item && item.vi !== undefined) {
      return [line(item.vi), ...copyBody(item)].join('\n');
    }
    const v = 'text' in item ? verdictOf(item.text) : undefined;
    if (v !== undefined) return copyVerdict(v);
    return 'text' in item ? item.text : '';
  }
}

/** A run's copy — the ▸-tally headline plus each member's line. */
const copyRuns = (item: Item, line: (vi: unknown) => string): string => {
  const runs = (item as ToolItem).runs ?? [];
  const members = runs.map(m => line(m)).filter(l => l !== '');
  return [`▸ ${runs.length} activity`, ...members].join('\n');
};

/** A tool's body lines below its one-liner. */
const copyBody = (item: Item): string[] =>
  'content' in item && Array.isArray(item.content) ? dumpContent(item.content) : [];

/** The verdict control's copy — badge plus typed fields. */
const copyVerdict = (v: NonNullable<ReturnType<typeof verdictOf>>): string =>
  [`⛨ jev · ${v.summary}`, ...v.fields.map(([q, f]) => `${q} ${f}`)].join('\n');
