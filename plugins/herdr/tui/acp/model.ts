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
import { isJudgeTurn } from '../verdict.ts';
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
    return [
      {
        type: 'prompt_response',
        stopReason: (row.stopReason ?? 'end_turn') as StopReason,
        at: t,
      },
    ];
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

const markerItem = (item: MarkerItem, id: number): SideItem => {
  if (item.markerKind === 'turn_end') {
    return {
      id,
      kind: 'turn',
      text: `── turn complete (${item.stopReason}) ──`,
      vi: item,
    };
  }
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
  judge?: boolean
): Item => {
  switch (item.kind) {
    case 'agent_message':
      return {
        id,
        kind: 'message',
        text: item.text,
        at: stamp,
        ...(judge === true ? { judge: true } : {}),
      };
    case 'user_message':
      // our model dims user_message chunks like thoughts — parity;
      // no `vi` — their line language has no user-bubble row here
      return { id, kind: 'thought', text: item.text, at: stamp };
    case 'thought':
      return { id, kind: 'thought', text: item.text, at: stamp, vi: item };
    case 'tool_call':
      return toolItem(item, id, args, folded, stamp);
    case 'plan':
      return { ...planItem(item, id), at: stamp };
    case 'permission_record':
      return { ...permissionItem(item, id), at: stamp };
    case 'marker':
      return { ...markerItem(item, id), at: stamp };
  }
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
  /** Their sids born under a judge-labelled turn — the reply text
   *  classifies as a verdict control at render. */
  private readonly judgeSids = new Set<string>();
  private judgeNow = false;
  /** Unknown sessionUpdates dropped by their reducer — the `▸ N
   *  hidden` row's count (hiddenId pins the one growing item). */
  private hidden = 0;
  private hiddenShown = 0;
  private hiddenId: number | undefined;
  /** Prompt items by feed position — drain() emits them inline; the
   *  dump interleaves them at `pos` (the session-order length when
   *  the row landed) so per-turn prompts stay chronological. */
  private readonly prompts: { pos: number; item: TextItem }[] = [];
  private ops: Op[] = [];

  feed(row: ArchiveRow): void {
    if (row.kind === 'prompt') {
      // the prompt row marks its turn — a typed-preamble body (or a
      // judge `by`) labels the reply for the verdict classifier
      this.judgeNow = isJudgeTurn(row.text, row.by);
      const id = this.nextId++;
      const item: TextItem = { id, kind: 'prompt', text: row.text ?? '', at: row.ts };
      this.emitted.push(id);
      this.ops.push({ op: 'append', item });
      this.prompts.push({ pos: this.session.order.length, item });
      return;
    }
    if (row.kind === 'turn') {
      if (row.phase === 'start') this.judgeNow = isJudgeTurn(undefined, row.by);
      else if (row.phase === 'stop') this.judgeNow = false;
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
    const ord = this.session.order;
    for (let i = orderLen; i < ord.length; i++) {
      const sid = ord[i];
      if (sid === undefined) continue;
      if (row.ts !== undefined) this.tsMap.set(sid, row.ts);
      if (this.judgeNow) this.judgeSids.add(sid);
    }
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
   *  re-projects whole; order is append-only per their reducer. */
  drain(): Op[] {
    if (this.session.items === this.prev && this.ops.length === 0) return this.ops;
    const ops = this.ops;
    this.ops = [];
    const items = this.session.items;
    for (const sid of this.session.order) {
      const item = items.get(sid);
      if (item === undefined) continue;
      const was = this.prev.get(sid);
      if (was === item) continue;
      let id = this.ids.get(sid);
      if (was === undefined) {
        id = this.nextId++;
        this.ids.set(sid, id);
        this.emitted.push(id);
        ops.push({
          op: 'append',
          item: project(item, id, this.args, true, this.tsMap.get(sid), this.judgeSids.has(sid)),
        });
        continue;
      }
      if (id === undefined) continue;
      const next = project(item, id, this.args, true, this.tsMap.get(sid), this.judgeSids.has(sid));
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
    const toolsByCall = new Map<string, TheirItem>();
    for (const sid of this.session.order) {
      const item = this.session.items.get(sid);
      if (item?.kind === 'tool_call') toolsByCall.set(item.toolCallId, item);
    }
    const find = (toolCallId: string): unknown => toolsByCall.get(toolCallId);
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
    for (let i = 0; i < ord.length; i++) {
      emitPrompts(i);
      const sid = ord[i];
      if (sid === undefined) continue;
      const item = this.session.items.get(sid);
      if (item === undefined) continue;
      let id = this.ids.get(sid);
      if (id === undefined) {
        id = this.nextId++;
        this.ids.set(sid, id);
      }
      const line = lineText(
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
      out.push(
        ...dumpItems([
          project(item, id, this.args, false, this.tsMap.get(sid), this.judgeSids.has(sid)),
        ])
      );
    }
    emitPrompts(Number.MAX_SAFE_INTEGER);
    if (this.hidden > 0) out.push(`▸ ${this.hidden} hidden`);
    return out;
  }
}
