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
import type {
  MarkerItem,
  PermissionRecordItem,
  PlanItem,
  Item as TheirItem,
  ToolCallItem,
} from 'acp-model';
import { createSession, type ModelEvent, reduce, type Session } from 'acp-model';
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
  type ToolItem,
  type ToolStatus,
} from '../model.ts';
import { acpLine, lineText } from './lines.ts';

const at = (row: ArchiveRow): number => {
  const ts = (row as { ts?: string }).ts;
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
  folded: boolean
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
 *  carries the pane's fold policy — the dump path projects open. */
const project = (
  item: TheirItem,
  id: number,
  args: ReadonlyMap<string, string>,
  folded = true
): Item => {
  switch (item.kind) {
    case 'agent_message':
      return { id, kind: 'message', text: item.text };
    case 'user_message':
      // our model dims user_message chunks like thoughts — parity;
      // no `vi` — their line language has no user-bubble row here
      return { id, kind: 'thought', text: item.text };
    case 'thought':
      return { id, kind: 'thought', text: item.text, vi: item };
    case 'tool_call':
      return toolItem(item, id, args, folded);
    case 'plan':
      return planItem(item, id);
    case 'permission_record':
      return permissionItem(item, id);
    case 'marker':
      return markerItem(item, id);
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
  private ops: Op[] = [];

  feed(row: ArchiveRow): void {
    // the arg stash — their items drop rawInput, our header wants it
    if (row.kind === 'update' && row.update !== undefined) {
      const u = row.update as SessionUpdateLike & { toolCallId?: string };
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
    for (const ev of eventsOf(row)) {
      this.session = reduce(this.session, ev);
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
        ops.push({ op: 'append', item: project(item, id, this.args) });
        continue;
      }
      if (id === undefined) continue;
      const next = project(item, id, this.args);
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
    for (const sid of this.session.order) {
      const item = this.session.items.get(sid);
      if (item === undefined) continue;
      let id = this.ids.get(sid);
      if (id === undefined) {
        id = this.nextId++;
        this.ids.set(sid, id);
      }
      const line = lineText(acpLine(item, 120, 0, find));
      if (line !== '') {
        out.push(line);
        if (item.kind === 'tool_call') {
          for (const l of dumpContent(toolItem(item, id, this.args, false).content)) {
            out.push(`│  ${l}`);
          }
        }
        continue;
      }
      out.push(...dumpItems([project(item, id, this.args, false)]));
    }
    return out;
  }
}
