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
 * nothing rather than fabricate a user message; permission rows map
 * to `permission_opened`.
 *
 * Their session is immutable and delta-free, so `drain()` diffs the
 * item maps and emits our ops — a changed item re-projects whole.
 * Tool args are not on their items (their card shows the wire
 * title), so the feed stashes `rawInput` per toolCallId on the way
 * past — our `toolArg` keeps its exact header/body fidelity.
 */

import type { LoadSessionResponse, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { PaneLed } from '../../../../packages/cli/src/commands/fleet-state.ts';
import type { ArchiveRow } from '../../../../packages/cli/src/commands/session-feed.ts';
import {
  type SessionUpdateLike,
  type ToolWire,
  toolArg,
} from '../../../../packages/providers/src/acp-render.ts';
import type { FoldPolicy, PaneImpl } from '../impl.ts';
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
} from '../model.ts';
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
} from '../vendor/acp-model/src/index.ts';
import { isJudgeTurn, verdictOf } from '../verdict.ts';
import { headBy, isInternalBy, TimeGutter } from '../view.ts';
import { acpLine, lineText } from './lines.ts';

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
 *  start` maps to none — `prompt_sent` would fabricate a user
 *  message the archive does not carry). */
function eventsOf(row: ArchiveRow): ModelEvent[] {
  const t = at(row);
  if (row.kind === 'update' && row.update !== undefined) {
    return [{ type: 'session_update', update: row.update as SessionUpdate, at: t }];
  }
  if (row.kind === 'turn' && row.phase === 'stop') {
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
  }
  if (row.kind === 'permission') {
    const toolCallId = ((row as { toolCallId?: string }).toolCallId ?? 'unknown') as never;
    return [
      {
        type: 'permission_opened',
        toolCallId,
        request: {
          sessionId: 'archive' as never,
          toolCall: {
            toolCallId,
            title: row.title ?? 'permission',
            status: 'in_progress',
          },
          options: [],
        },
        at: t,
      },
    ];
  }
  return [];
}

/** Their tool status → ours (their 'cancelled' reads as our failed). */
const TOOL_STATUS: Record<string, ToolStatus> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};
const toolStatus = (s: string): ToolStatus => TOOL_STATUS[s] ?? 'live';

/** One tool_call → our card. `arg` comes from the feed's rawInput
 *  stash — their item deliberately drops it. `folded` marks the
 *  pane's default; the dump path passes false (a dump is the full
 *  readout, the fold is pane state). */
const toolItem = (
  item: ToolCallItem,
  id: number,
  args: ReadonlyMap<string, string>,
  folded: boolean,
  stamp?: string
): ToolItem => {
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
  const arg = args.get(item.toolCallId);
  return {
    id,
    kind: 'tool',
    toolCallId: item.toolCallId,
    title: item.title === '' ? (item.toolName ?? 'tool') : item.title,
    toolKind: item.toolKind ?? undefined,
    arg: arg === '' ? undefined : arg,
    status: toolStatus(item.toolStatus),
    bodyLanded: content.length > 0,
    collapsed: folded && content.length > 0,
    content,
    at: stamp,
    vi: item,
  };
};

const PLAN_BOX: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

const planItem = (item: PlanItem, id: number): SideItem => {
  const lines = ['── plan ──'];
  for (const e of item.entries) {
    lines.push(`  ${PLAN_BOX[e.status] ?? '[~]'} ${e.content}`);
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

/** Their item → ours (numeric id assigned by the diff). `folded`
 *  carries the pane's fold policy — the dump path projects open.
 *  `stamp`/`judge` come from the feed's birth-row records. */
const project = (
  item: TheirItem,
  id: number,
  args: ReadonlyMap<string, string>,
  folded = true,
  stamp?: string,
  judge?: boolean,
  by?: string
): Item | undefined => {
  const base = { at: stamp, ...(by !== undefined ? { by } : {}) };
  switch (item.kind) {
    case 'agent_message':
      return {
        id,
        kind: 'message',
        text: item.text,
        ...base,
        ...(judge === true ? { judge: true } : {}),
      };
    case 'user_message':
      // our model dims user_message chunks like thoughts — parity;
      // no `vi` — their line language has no user-bubble row here
      return { id, kind: 'thought', text: item.text, ...base };
    case 'thought':
      return { id, kind: 'thought', text: item.text, ...base, vi: item };
    case 'tool_call':
      return { ...toolItem(item, id, args, folded, stamp), ...(by !== undefined ? { by } : {}) };
    case 'plan':
      return { ...planItem(item, id), ...base };
    case 'permission_record':
      return { ...permissionItem(item, id), ...base };
    case 'marker': {
      const m = markerItem(item, id);
      return m === undefined ? undefined : { ...m, ...base };
    }
  }
};

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
): Map<string, string> => {
  const out = new Map<string, string>();
  let run: string[] = [];
  const flush = (): void => {
    const lead = run[0];
    if (run.length >= 2 && lead !== undefined) {
      for (const sid of run) out.set(sid, lead);
    }
    run = [];
  };
  for (const sid of order) {
    const item = items.get(sid);
    if (item !== undefined && ACTIVITY.has(item.kind) && internal?.has(sid) !== true) run.push(sid);
    else flush();
  }
  flush();
  return out;
};

/** Runs of consecutive internal sids in session order → member sid →
 *  its storm's leader (first sid). Unlike activity runs even ONE sid
 *  forms a storm — a lone judge probe still reads `▸ 1 internal
 *  call`, never a bare one-token reply (addendum 27). */
const buildStorms = (
  order: readonly string[],
  internal: ReadonlySet<string>
): Map<string, string> => {
  const out = new Map<string, string>();
  let run: string[] = [];
  const flush = (): void => {
    const lead = run[0];
    if (lead !== undefined) for (const sid of run) out.set(sid, lead);
    run = [];
  };
  for (const sid of order) {
    if (internal.has(sid)) run.push(sid);
    else flush();
  }
  flush();
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
  leader: string
): TheirItem[] => {
  const start = order.indexOf(leader);
  if (start < 0) return [];
  const out: TheirItem[] = [];
  for (let i = start; i < order.length; i++) {
    const item = items.get(order[i] ?? '');
    if (item === undefined || !ACTIVITY.has(item.kind)) break;
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
const runItem = (
  members: readonly TheirItem[],
  id: number,
  folded: boolean,
  stamp: string | undefined,
  by: string | undefined
): ToolItem => {
  let started: number | undefined;
  let ended: number | undefined;
  let live = false;
  let failed = false;
  for (const m of members) {
    if (m.kind === 'tool_call') {
      if (m.startedAt !== null) started = Math.min(started ?? m.startedAt, m.startedAt);
      if (m.endedAt !== null) ended = Math.max(ended ?? m.endedAt, m.endedAt);
      if (m.toolStatus === 'in_progress' || m.toolStatus === 'pending') live = true;
      if (m.toolStatus === 'failed') failed = true;
    }
  }
  const secs =
    !live && started !== undefined && ended !== undefined && ended > started
      ? ` · ${((ended - started) / 1000).toFixed(1)}s`
      : '';
  return {
    id,
    kind: 'tool',
    toolCallId: `run:${id}`,
    title: 'activity',
    arg: `${tally(members)}${secs}${by !== undefined ? ` · ${by}` : ''}`,
    status: live ? 'live' : failed ? 'failed' : 'completed',
    bodyLanded: true,
    collapsed: folded,
    content: [],
    at: stamp,
    ...(by !== undefined ? { by } : {}),
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
  id: number,
  folded: boolean,
  stamp: string | undefined,
  by: string | undefined
): ToolItem => {
  const members: TheirItem[] = [];
  let calls = 0;
  let fails = 0;
  let live = false;
  const origins: string[] = [];
  for (const sid of memberSids) {
    const m = items.get(sid);
    const o = byMap.get(sid);
    if (o !== undefined && o !== '' && !origins.includes(o)) origins.push(o);
    if (m === undefined) continue;
    members.push(m);
    if (m.kind === 'marker') {
      // a finished turn journals TWO markers — the end_turn plus,
      // on failure, the error — so calls counts ends, not markers
      if (m.markerKind === 'turn_end') calls++;
      if (m.markerKind === 'error') fails++;
    }
  }
  // a trailing non-marker member = a turn still in flight
  const last = members[members.length - 1];
  live = last !== undefined && last.kind !== 'marker';
  if (live) calls++;
  const org =
    origins.length <= 3
      ? origins.join(', ')
      : `${origins.slice(0, 2).join(', ')} +${origins.length - 2}`;
  return {
    id,
    kind: 'tool',
    toolCallId: `storm:${id}`,
    title: 'internal',
    arg: `${calls} internal ${calls === 1 ? 'call' : 'calls'}${fails > 0 ? ` · ${fails} failed` : ''}${org !== '' ? ` · ${org}` : ''}`,
    status: fails > 0 ? 'failed' : 'completed',
    bodyLanded: true,
    collapsed: folded,
    content: [],
    at: stamp,
    ...(by !== undefined ? { by } : {}),
    runs: members,
  };
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

  feed(row: ArchiveRow): void {
    this.launchTs ??= row.ts;
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
      } else if (row.phase === 'stop') this.judgeNow = false;
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
    const orderLen = this.session.order.length;
    for (const ev of eventsOf(row)) {
      this.session = reduce(this.session, ev);
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
      return { led: { state: 'blocked' }, mode: 'agent exited' };
    }
    switch (s.state) {
      case 'requires_action':
        return { led: { state: 'blocked' }, mode: 'permission' };
      case 'running':
        return { led: { state: 'working' }, mode: 'turn' };
      default:
        return {
          led: { state: 'idle' },
          mode: s.stopReason !== null ? 'turn complete' : 'idle',
        };
    }
  }

  /** Diff the session against the last drain — every changed item
   *  re-projects whole; order is append-only per their reducer.
   *  Runs of ≥2 consecutive activity items collapse into ONE
   *  `▸ N tool calls · …` group item (the confirmed live density) —
   *  the run's leader keeps its slot and morphs in place when the
   *  second member lands. */
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
      u !== null && u !== undefined && u.size > 0
        ? ` · ctx ${Math.round(u.used / 1000)}k/${Math.round(u.size / 1000)}k`
        : '';
    const arg = `${last.arg}${dur}${ctx}`;
    last.arg = arg;
    ops.push({ op: 'tool', item: { id: last.id, arg } });
  }

  drain(): Op[] {
    if (this.session.items === this.prev && this.ops.length === 0) return this.ops;
    const ops = this.ops;
    this.ops = [];
    this.emitHeader(ops);
    const items = this.session.items;
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
      const members = nowGrouped ? runMembers(this.session.order, items, sid) : undefined;
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
        const next =
          stormSids !== undefined
            ? stormItem(
                stormSids,
                items,
                this.byMap,
                id,
                true,
                this.tsMap.get(sid),
                this.byMap.get(sid)
              )
            : members !== undefined
              ? runItem(members, id, true, this.tsMap.get(sid), this.byMap.get(sid))
              : project(
                  item,
                  id,
                  this.args,
                  true,
                  this.tsMap.get(sid),
                  this.judgeSids.has(sid),
                  this.byMap.get(sid)
                );
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
            const row = project(
              item,
              this.nextId++,
              this.args,
              true,
              this.tsMap.get(sid),
              this.judgeSids.has(sid),
              this.byMap.get(sid)
            );
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
      const next =
        stormSids !== undefined
          ? stormItem(
              stormSids,
              items,
              this.byMap,
              id,
              true,
              this.tsMap.get(sid),
              this.byMap.get(sid)
            )
          : members !== undefined
            ? runItem(members, id, true, this.tsMap.get(sid), this.byMap.get(sid))
            : project(
                item,
                id,
                this.args,
                true,
                this.tsMap.get(sid),
                this.judgeSids.has(sid),
                this.byMap.get(sid)
              );
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
    /** the last ▸ line's index — a turn_end folds duration/ctx into
     *  its arg instead of a row (same as the drain path) */
    let lastRun = -1;
    // prompt items interleave at the order position they landed —
    // per-turn prompts stay chronological through the readout
    let pi = 0;
    const emitPrompts = (pos: number): void => {
      while (pi < this.prompts.length && (this.prompts[pi]?.pos ?? 0) <= pos) {
        const p = this.prompts[pi];
        pi++;
        if (p === undefined) continue;
        if (p.item.text === '') out.push('▸ prompt unavailable');
        else for (const l of p.item.text.split('\n')) out.push(`▸ ${l}`);
      }
    };
    const ord = this.session.order;
    const memberGroup = buildRuns(ord, this.session.items, this.internalSids);
    const storm = buildStorms(ord, this.internalSids);
    for (let i = 0; i < ord.length; i++) {
      emitPrompts(i);
      const sid = ord[i];
      if (sid === undefined) continue;
      const item = this.session.items.get(sid);
      if (item === undefined) continue;
      const errorMarker = item.kind === 'marker' && item.markerKind === 'error';
      const stormLeader = storm.get(sid);
      if (stormLeader !== undefined && stormLeader !== sid && !errorMarker) continue;
      const leader = memberGroup.get(sid);
      if (leader !== undefined && leader !== sid) continue;
      let id = this.ids.get(sid);
      if (id === undefined) {
        id = this.nextId++;
        this.ids.set(sid, id);
      }
      // no row — duration/ctx fold into the preceding ▸ line's arg
      if (item.kind === 'marker' && item.markerKind === 'turn_end') {
        if (lastRun >= 0) {
          const dur = item.durationMs > 0 ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : '';
          const u = item.usage;
          const ctx =
            u !== null && u !== undefined && u.size > 0
              ? ` · ctx ${Math.round(u.used / 1000)}k/${Math.round(u.size / 1000)}k`
              : '';
          out[lastRun] = `${out[lastRun]}${dur}${ctx}`;
        }
        continue;
      }
      if (leader === sid) {
        // the ▸-tally line; members hang under it in the │ gutter
        const members = runMembers(ord, this.session.items, sid);
        lastRun = out.length;
        out.push(`▸ ${runItem(members, id, false, undefined, this.byMap.get(sid)).arg}`);
        for (const m of members) {
          const ml = lineText(
            acpLine(
              m,
              116,
              0,
              find,
              m.kind === 'tool_call' ? this.args.get(m.toolCallId) : undefined
            )
          );
          out.push(`│  ${ml === '' ? m.kind : ml.trimEnd()}`);
        }
        continue;
      }
      if (stormLeader === sid) {
        // the ▸-storm line — same grammar; internal members show
        // their own one-liners under the gutter
        const memberSids = stormMembers(ord, this.internalSids, sid);
        const st = stormItem(
          memberSids,
          this.session.items,
          this.byMap,
          id,
          false,
          undefined,
          this.byMap.get(sid)
        );
        out.push(`▸ ${st.arg}`);
        for (const msid of memberSids) {
          const m = this.session.items.get(msid);
          if (m === undefined) continue;
          const ml = lineText(
            acpLine(
              m,
              116,
              0,
              find,
              m.kind === 'tool_call' ? this.args.get(m.toolCallId) : undefined
            )
          );
          out.push(`│  ${ml === '' ? m.kind : ml.trimEnd()}`);
        }
        continue;
      }
      // an internal error marker prints its origin inline — inside a
      // storm the lone banner can't be attributed otherwise
      const line =
        errorMarker && this.internalSids.has(sid) && item.kind === 'marker'
          ? stormErrText(item, this.byMap.get(sid))
          : lineText(
              acpLine(
                item,
                120,
                0,
                find,
                item.kind === 'tool_call' ? this.args.get(item.toolCallId) : undefined
              )
            );
      if (line !== '') {
        out.push(line);
        if (item.kind === 'tool_call') {
          for (const l of dumpContent(
            toolItem(item, id, this.args, false, this.tsMap.get(sid)).content
          )) {
            out.push(`│  ${l}`);
          }
        }
        continue;
      }
      const p = project(
        item,
        id,
        this.args,
        false,
        this.tsMap.get(sid),
        this.judgeSids.has(sid),
        this.byMap.get(sid)
      );
      if (p === undefined) continue;
      // judge replies print the verdict control, not the JSON wall —
      // the same shape classification the pane's VerdictRow uses;
      // the badge is the call's model/provider, never a brand literal
      if ('text' in p) {
        const v = verdictOf(p.text);
        if (v !== undefined) {
          out.push(`⛨ ${v.model ?? p.by ?? 'verdict'} · ${v.summary}`);
          for (const [q, f] of v.fields) out.push(`   ${q} ${f}`);
          continue;
        }
      }
      out.push(...dumpItems([p]));
    }
    emitPrompts(Number.MAX_SAFE_INTEGER);
    if (this.hidden > 0) out.push(`▸ ${this.hidden} hidden`);
    return out;
  }

  /** The item's full raw text for Ctrl+C — the impl's line language
   *  at copy width (no display clip): a run emits every member's
   *  line, a tool its one-liner + full body, a verdict its control
   *  text, everything else its raw text. */
  copyText(item: Item): string {
    const line = (vi: unknown): string => lineText(acpLine(vi, 400, 0, () => undefined));
    if ('runs' in item && item.runs !== undefined) {
      const members = (item.runs as readonly unknown[]).map(m => line(m)).filter(l => l !== '');
      return [`▸ ${item.runs.length} activity`, ...members].join('\n');
    }
    if ('vi' in item && item.vi !== undefined) {
      const body =
        'content' in item && Array.isArray(item.content) ? dumpContent(item.content) : [];
      return [line(item.vi), ...body].join('\n');
    }
    const v = 'text' in item ? verdictOf(item.text) : undefined;
    if (v !== undefined) {
      return [`⛨ jev · ${v.summary}`, ...v.fields.map(([q, f]) => `${q} ${f}`)].join('\n');
    }
    return 'text' in item ? item.text : '';
  }
}
