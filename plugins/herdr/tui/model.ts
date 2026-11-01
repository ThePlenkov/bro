/**
 * The session pane's model (spec bro-q2edc) — the pure half of the
 * OpenTUI view. Archive rows in, an item tree + mutations out; no
 * renderables, no fs, no timers — `main.ts` applies the ops and the
 * tests assert the tree directly.
 *
 * Wire semantics are shared, not re-derived: `ArchiveRow` and the
 * row→LED verdict come from session-feed (the same contract
 * `bro herdr session-view` reports on), and the update parsing —
 * chunk text, tool arg extraction, content classification, the
 * sanitize posture — is the providers' `acp-render` module verbatim.
 */

import type { PaneLed } from '../../../packages/cli/src/commands/fleet-state.ts';
import { type ArchiveRow, rowVerdict } from '../../../packages/cli/src/commands/session-feed.ts';
import {
  chunkText,
  clip,
  DONE_STATUS,
  firstLine,
  type SessionUpdateLike,
  safe,
  safeBlock,
  type ToolContent,
  toolArg,
  toolContent,
} from '../../../packages/providers/src/acp-render.ts';
import { isJudgeTurn } from './verdict.ts';
import { isInternalBy, shortBy, TimeGutter } from './view.ts';

export type { ToolContent };

/** The scrollback bound — past it the oldest items evict (the shell
 *  destroys their renderables). opencode's notification-demo bound,
 *  generous for a session view. */
export const MAX_ITEMS = 500;

export type ToolStatus = 'live' | 'completed' | 'failed';

/** A streaming text block — agent speech or dim thought; `text`
 *  grows in place as same-kind chunks arrive. */
export interface TextItem {
  id: number;
  /** `prompt` rows are journaled by `AgentTurnPlane.start` (or the
   *  `.prompt.md` fallback on old archives) — the user-side surface
   *  (empty text = the `▸ prompt unavailable` marker). */
  kind: 'message' | 'thought' | 'prompt' | 'header';
  text: string;
  /** The row's ISO stamp — the pane's HH:MM gutter. */
  at?: string;
  /** Judge-labelled turn — the reply text may classify as a verdict
   *  control instead of a message (verdict.ts's shape table). */
  judge?: boolean;
  /** The row's `by` label — the call's origin (provider/conductor)
   *  rendered on turn blocks and verdict badges (addendum 11). */
  by?: string;
  /** Long text blocks fold by default — the row shows a `+N lines`
   *  summary until the user expands it (addendum 20). */
  collapsed?: boolean;
  /** The user explicitly toggled the fold — auto-fold never
   *  overrides a deliberate state. */
  foldTouched?: boolean;
  /** The impl's source item (acp impl: their Item). The view renders
   *  the impl's row language when present — opaque to this seam. */
  vi?: unknown;
}

/** A tool call card — the header (glyph, title, kind, arg) plus the
 *  finished call's classified content. */
export interface ToolItem {
  id: number;
  kind: 'tool';
  toolCallId: string;
  title: string;
  toolKind?: string;
  arg?: string;
  status: ToolStatus;
  /** The completion card landed — a content-carrying repeat of a
   *  terminal status still prints it, but never twice. */
  bodyLanded: boolean;
  collapsed: boolean;
  /** The user explicitly toggled this card's fold — the selection
   *  preview (j/k lands on a collapsed card) opens only untouched
   *  folds, so a deliberate close survives being selected. */
  foldTouched?: boolean;
  content: ToolContent[];
  at?: string;
  /** The row's `by` label — the turn's origin (provider/conductor),
   *  folded into the ▸ run line's arg. */
  by?: string;
  vi?: unknown;
  /** An activity-run group (the acp impl's `▸ N tool calls · …`
   *  line): the collapsed members, in order, for the expanded body.
   *  `arg` carries the tally text. */
  runs?: readonly unknown[];
}

/** A one-shot line — turn boundary, permission ask, plan block, a
 *  time separator (minute/origin heads and day markers), or a dim
 *  one-liner for every other update kind. `tone` is the pane's
 *  accent hint: permission asks read warn, failed turns read error. */
export interface SideItem {
  id: number;
  kind: 'turn' | 'permission' | 'note' | 'time';
  text: string;
  tone?: 'warn' | 'error';
  at?: string;
  by?: string;
  collapsed?: boolean;
  foldTouched?: boolean;
  vi?: unknown;
}

export type Item = TextItem | ToolItem | SideItem;

/** The ops a feed() call returns — the shell's apply order. A `tool`
 *  op may carry a partial card (the acp impl omits `collapsed` so the
 *  fold keeps the user's toggle across updates). */
export type Op =
  | { op: 'append'; item: Item }
  | { op: 'text'; id: number; text: string }
  | { op: 'tool'; item: Partial<ToolItem> & Pick<ToolItem, 'id'> }
  | { op: 'evict'; ids: number[] };

interface ToolRec {
  item: ToolItem;
  status?: string;
  edge?: string;
}

const PLAN_BOX: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

const scalar = (v: unknown): string => {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' ? String(v) : '?';
};

export class SessionModel {
  readonly items: Item[] = [];
  /** The archive's latest LED verdict — the shell reports it. */
  verdict: { led: PaneLed; mode: string } | undefined;
  private readonly tools = new Map<string, ToolRec>();
  private nextId = 1;
  private ops: Op[] = [];
  /** The current row's stamp — items born under it inherit the
   *  gutter time; judge-turn flag set by `prompt`/`turn` rows. */
  private curTs: string | undefined;
  private judgeNow = false;
  /** The separator layer — turn starts mark the origin, every item
   *  birth lazily owes the minute/origin heads and day markers. */
  private readonly gutter = new TimeGutter();
  /** The chunk tail seals at every turn boundary — the next message
   *  births a fresh item instead of merging into the LAST turn's
   *  prose (the `okok`/`ok{}{}sum` artifact: N turns' one-token
   *  replies glued into one fake message). */
  private sealed = false;
  /** Inside an internal turn — conductor/provider/transport calls
   *  the orchestrator journals alongside the agent's. Their rows
   *  never emit items; they batch into `micro` below. */
  private curInternal = false;
  /** The internal-call storm batch (addendum 27): a run of internal
   *  rows collapses into ONE foldable `▸ N internal calls · K failed`
   *  note whose body is the per-call detail list — the analytics the
   *  fold owes the reader. Unique failures still emit their own red
   *  `✗` row the moment they happen — errors never hide in a fold. */
  private micro = {
    id: 0,
    calls: 0,
    fails: 0,
    errors: new Set<string>(),
    details: [] as string[],
    extra: 0,
    pendBy: '',
    pendQ: '',
    pendText: '',
    pendDetail: -1,
    tools: new Set<string>(),
    /** origin → call count, insert-ordered — the head's
     *  `· kilo, fake +4` provenance glance (acp impl parity) */
    origins: new Map<string, number>(),
  };

  /** Every op produced since the last drain — the shell's queue. */
  drain(): Op[] {
    const out = this.ops;
    this.ops = [];
    return out;
  }

  /** One archive row — update rows dispatch into the item tree, turn
   *  and permission rows land as side items; the row's LED verdict
   *  rides `this.verdict`. Internal-provenance rows (conductor:*,
   *  provider:*, acp-transport:*) never dispatch — they batch into
   *  the `▸ N internal calls` storm note. */
  feed(row: ArchiveRow): void {
    this.curTs = row.ts;
    const internal =
      row.by !== undefined && row.by !== '' ? isInternalBy(row.by) : this.curInternal;
    switch (row.kind) {
      case 'update':
        if (internal) {
          this.microUpdate(row);
          break;
        }
        this.microClose();
        if (row.update !== undefined) this.update(row.update);
        break;
      case 'turn':
        if (row.phase === 'start') {
          this.judgeNow = isJudgeTurn(undefined, row.by);
          this.gutter.start(row.by);
          this.sealed = true;
          this.curInternal = isInternalBy(row.by);
          if (this.curInternal) this.microStart(row.by);
          else this.microClose();
        } else if (row.phase === 'stop') {
          this.judgeNow = false;
          this.sealed = true;
          if (this.curInternal || internal) {
            this.microStop(row);
            this.curInternal = false;
            break;
          }
          // a normal end_turn prints nothing — every turn ends;
          // only failures and abnormal stops earn a marker row
          const failed = row.error !== undefined && row.error !== '';
          const reason = row.stopReason ?? '';
          if (!failed && (reason === '' || reason === 'end_turn')) break;
          this.side(
            'turn',
            failed
              ? `── turn failed — ${safe(row.error ?? '')} ──`
              : `── turn ended (${safe(reason)}) ──`,
            failed ? 'error' : undefined
          );
        }
        break;
      case 'prompt':
        if (internal) {
          // a probe call's question — first line rides the batch
          // detail (`by « question → reply`) instead of the card
          const q = firstLine(safe(row.text ?? ''));
          if (q !== '' && this.micro.pendDetail >= 0) {
            this.micro.pendQ = q;
            this.micro.details[this.micro.pendDetail] = this.microDetail();
            this.microPatch();
          }
          break;
        }
        this.microClose();
        // the prompt row marks its turn — judge prompts carry the
        // typed preamble; the reply then classifies as a verdict
        this.judgeNow = isJudgeTurn(row.text, row.by);
        this.gutter.start(row.by);
        this.push<TextItem>({ kind: 'prompt', text: row.text ?? '' });
        break;
      case 'permission': {
        // visible even inside a storm — a headless internal call
        // still wanted something — and the batch survives across it
        const what = row.title ?? 'permission request';
        const verdict = row.verdict ?? 'denied';
        this.side(
          'permission',
          `── ⚠ permission ‹${safe(what)}› — ${safe(verdict)} (headless driver; open a terminal in this workspace to handle interactively) ──`,
          'warn'
        );
        break;
      }
      default:
        break;
    }
    const v = rowVerdict(row);
    if (v !== undefined) this.verdict = v;
    this.evict();
  }

  /** One session/update value — the same dispatch the line renderer
   *  runs, but into items instead of lines. */
  update(u: SessionUpdateLike): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.chunk('message', chunkText(u));
        return;
      case 'agent_thought_chunk':
      case 'user_message_chunk':
        this.chunk('thought', chunkText(u));
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.onTool(u);
        return;
      case 'plan':
        this.onPlan(u);
        return;
      default:
        this.side('note', this.noteLine(u));
    }
  }

  /** Append + record — every item birth goes through here, first
   *  paying the separator layer whatever the row's `ts` owes (day
   *  marker, then the `── HH:MM · by ──` group head). Stamped with
   *  the row's `ts` and, for messages, the judge-turn flag. */
  private push<T extends Item>(item: Omit<T, 'id'>): T {
    for (const text of this.gutter.tick(this.curTs)) {
      const sep: SideItem = { id: this.nextId++, kind: 'time', text, at: this.curTs };
      this.items.push(sep);
      this.ops.push({ op: 'append', item: sep });
    }
    const judge = 'kind' in item && item.kind === 'message' && this.judgeNow;
    const it = {
      ...item,
      id: this.nextId++,
      at: this.curTs,
      ...(judge ? { judge: true } : {}),
    } as T;
    this.items.push(it);
    this.ops.push({ op: 'append', item: it });
    return it;
  }

  private side(kind: SideItem['kind'], text: string, tone?: SideItem['tone']): void {
    this.push<SideItem>({ kind, text, tone });
  }

  /** Detail lines the fold keeps — past the cap calls tally into
   *  `+N more` so a 900-call storm never grows the item's text. */
  private static readonly MICRO_DETAILS = 30;

  /** The batch note's text — `▸ N internal calls · K failed` then
   *  the per-call details (markdown `-` list in the expanded body). */
  private microText(): string {
    const b = this.micro;
    const origins = [...b.origins.keys()];
    const org =
      origins.length <= 3
        ? origins.join(', ')
        : `${origins.slice(0, 2).join(', ')} +${origins.length - 2}`;
    const head = `▸ ${b.calls} internal ${b.calls === 1 ? 'call' : 'calls'}${b.fails > 0 ? ` · ${b.fails} failed` : ''}${org === '' ? '' : ` · ${org}`}`;
    const more = b.extra > 0 ? `\n- +${b.extra} more` : '';
    return `${head}${b.details.length > 0 ? `\n${b.details.join('\n')}` : ''}${more}`;
  }

  /** Birth-or-patch the batch item — the note exists from the first
   *  absorbed row so a live storm's tally ticks in place. */
  private microPatch(): void {
    const text = this.microText();
    if (this.micro.id === 0) {
      const it = this.push<SideItem>({ kind: 'note', text, collapsed: true });
      this.micro.id = it.id;
      this.microItem = it;
      return;
    }
    if (this.microItem !== undefined) this.microItem.text = text;
    this.ops.push({ op: 'text', id: this.micro.id, text });
  }
  /** The open batch's own item — kept by reference so patching is
   *  O(1) per absorbed row (an evicted item just stops painting). */
  private microItem: SideItem | undefined;

  /** The open turn's detail line — `by « question → reply` growing
   *  as chunks land; the stop row appends the outcome glyph. */
  private microDetail(): string {
    const b = this.micro;
    const q = b.pendQ === '' ? '' : ` « ${clip(b.pendQ, 48)}`;
    const t = firstLine(safe(b.pendText));
    const r = t === '' ? '' : ` → \`${clip(t, 48)}\``;
    return `- ${b.pendBy}${q}${r}`;
  }

  /** An internal turn opened — one call in the tally, one pending
   *  detail line the updates/stop keep patching. */
  private microStart(by: string | undefined): void {
    const b = this.micro;
    b.calls++;
    b.pendBy = shortBy(by) ?? by ?? '?';
    b.origins.set(b.pendBy, (b.origins.get(b.pendBy) ?? 0) + 1);
    b.pendQ = '';
    b.pendText = '';
    if (b.details.length < SessionModel.MICRO_DETAILS) {
      b.details.push(this.microDetail());
      b.pendDetail = b.details.length - 1;
    } else {
      b.extra++;
      b.pendDetail = -1;
    }
    this.microPatch();
  }

  /** An internal turn closed — the pending detail seals with its
   *  outcome (`✓` silent-ok, `✗` error, `◌` abnormal stop). Unique
   *  errors also emit their own red row — visible without a fold. */
  private microStop(row: ArchiveRow): void {
    const b = this.micro;
    const by = b.pendBy !== '' ? b.pendBy : (shortBy(row.by) ?? '?');
    if (b.pendBy === '' && b.pendDetail < 0) {
      // a stop whose start fell outside the slice — still a call
      b.calls++;
      b.origins.set(by, (b.origins.get(by) ?? 0) + 1);
      if (b.details.length < SessionModel.MICRO_DETAILS) {
        b.details.push(`- ${by}`);
        b.pendDetail = b.details.length - 1;
      } else {
        b.extra++;
      }
    }
    const failed = row.error !== undefined && row.error !== '';
    const reason = row.stopReason ?? '';
    const base = b.pendBy !== '' ? this.microDetail() : `- ${by}`;
    let fin = base;
    if (failed) fin = `${base} ✗ ${safe(row.error ?? '')}`;
    else if (reason !== '' && reason !== 'end_turn') fin = `${base} ◌ ${safe(reason)}`;
    else if (base === `- ${by}`) fin = `${base} ✓`;
    if (b.pendDetail >= 0) b.details[b.pendDetail] = fin;
    if (failed) {
      b.fails++;
      const key = `${by}|${row.error ?? ''}`;
      if (!b.errors.has(key)) {
        b.errors.add(key);
        this.side('turn', `✗ ${by} · ${safe(row.error ?? '')}`, 'error');
      }
    }
    b.pendBy = '';
    b.pendQ = '';
    b.pendText = '';
    b.pendDetail = -1;
    this.microPatch();
  }

  /** An internal update row — reply chunks grow the open turn's
   *  detail; tool opens add a `⚙` line; every other kind is storm
   *  noise the tally already covers. */
  private microUpdate(row: ArchiveRow): void {
    const u = row.update;
    if (u === undefined) return;
    const b = this.micro;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk': {
        const t = chunkText(u);
        if (t === '') return;
        if (b.pendDetail >= 0) {
          b.pendText += t;
          b.details[b.pendDetail] = this.microDetail();
        } else if (b.details.length < SessionModel.MICRO_DETAILS) {
          // an orphan chunk (no open turn) — its own call line
          b.calls++;
          const o = shortBy(row.by) ?? '?';
          b.origins.set(o, (b.origins.get(o) ?? 0) + 1);
          b.details.push(`- ${o} → \`${clip(firstLine(safe(t)), 48)}\``);
        } else {
          b.calls++;
          b.extra++;
        }
        this.microPatch();
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String((u as { toolCallId?: unknown }).toolCallId ?? '');
        if (id === '' || b.tools.has(id)) return;
        b.tools.add(id);
        const title = firstLine(
          safe(String((u as { title?: unknown }).title ?? (u as { name?: unknown }).name ?? 'tool'))
        );
        if (b.details.length < SessionModel.MICRO_DETAILS) {
          b.details.push(`- ${shortBy(row.by) ?? b.pendBy} ⚙ ${clip(title, 48)}`);
        } else {
          b.extra++;
        }
        this.microPatch();
        return;
      }
      default:
        return;
    }
  }

  /** A non-internal row arrived — the storm run is over; the next
   *  internal row opens a fresh batch item. The item itself stays. */
  private microClose(): void {
    const b = this.micro;
    b.id = 0;
    this.microItem = undefined;
    b.calls = 0;
    b.fails = 0;
    b.errors.clear();
    b.details = [];
    b.extra = 0;
    b.pendBy = '';
    b.pendQ = '';
    b.pendText = '';
    b.pendDetail = -1;
    b.tools.clear();
    b.origins.clear();
  }

  /** Chunks commit incrementally — a same-kind tail item grows via a
   *  text op, a kind switch (or any structural item) seals the tail
   *  and opens a new one. Pacing lives in the shell's op-drain timer,
   *  not the model: the stream viewer wants the token stream. */
  private chunk(kind: 'message' | 'thought', text: string): void {
    if (text === '') return;
    const tail = this.items[this.items.length - 1];
    if (tail !== undefined && tail.kind === kind && !this.sealed) {
      tail.text += text;
      this.ops.push({ op: 'text', id: tail.id, text: tail.text });
      return;
    }
    this.sealed = false;
    this.push<TextItem>({ kind, text });
  }

  private onTool(u: SessionUpdateLike): void {
    const t = u as {
      toolCallId?: string;
      title?: string | null;
      name?: string | null;
      kind?: string | null;
      status?: string | null;
      content?: unknown;
      rawInput?: unknown;
      locations?: { path?: unknown }[] | null;
    };
    const id = t.toolCallId ?? '?';
    let rec = this.tools.get(id);
    let born = false;
    if (rec === undefined) {
      const item = this.push<ToolItem>({
        kind: 'tool',
        toolCallId: id,
        title: 'tool',
        status: 'live',
        bodyLanded: false,
        collapsed: false,
        content: [],
      });
      rec = { item };
      this.tools.set(id, rec);
      born = true;
    }
    const item = rec.item;
    for (const k of ['title', 'name'] as const) {
      const v = t[k];
      // the header is ONE line — a multiline wire title (a heredoc
      // command) keeps its first non-empty line, never a ⏎ mash
      if (typeof v === 'string' && v !== '') {
        item.title = clip(firstLine(safeBlock(v)), 80);
      }
    }
    if (typeof t.kind === 'string' && t.kind !== '') item.toolKind = safe(t.kind);
    const arg = toolArg(t, item.toolKind);
    if (arg !== undefined) item.arg = arg;
    const status = typeof t.status === 'string' && t.status !== '' ? safe(t.status) : 'pending';
    const content = Array.isArray(t.content) ? t.content : [];
    const done = DONE_STATUS.has(status);
    // the line renderer's dedupe, lifted: a repeat status is churn —
    // EXCEPT a terminal repeat that newly carries content, which is
    // still owed its card (once, flagged by bodyLanded)
    if (rec.status === status || rec.edge === (done ? status : 'live')) {
      rec.status = status;
      if (done && !item.bodyLanded && content.length > 0) {
        item.bodyLanded = true;
        item.content = content.map(toolContent);
        this.pushTool(item);
      }
      return;
    }
    rec.status = status;
    rec.edge = done ? status : 'live';
    item.status = done ? (status as ToolStatus) : 'live';
    if (done && content.length > 0) {
      item.bodyLanded = true;
      item.content = content.map(toolContent);
    }
    // a just-born item's append op already carries the populated card —
    // a second tool op would paint it twice
    if (!born) this.pushTool(item);
  }

  /** A routine tool update op — pane-owned fold fields stay out so a
   *  status churn never re-opens the pane's fold (the acp impl's
   *  convention). The deliberate `toggle` carries `collapsed`. */
  private pushTool(item: ToolItem): void {
    const { collapsed: _c, foldTouched: _f, ...rest } = item;
    this.ops.push({ op: 'tool', item: rest });
  }

  private onPlan(u: SessionUpdateLike): void {
    const entries = (u.entries as { content?: string; status?: string }[] | undefined) ?? [];
    const lines = ['── plan ──'];
    for (const e of entries) {
      const box = PLAN_BOX[e.status ?? ''] ?? '[~]';
      lines.push(`  ${box} ${e.content !== undefined ? safe(e.content) : '?'}`);
    }
    this.side('note', lines.join('\n'));
  }

  /** The dim one-liner for every other update kind — same mapping as
   *  the line renderer's `structured` table + unknown-kind fallback. */
  private noteLine(u: SessionUpdateLike): string {
    switch (u.sessionUpdate) {
      case 'usage_update': {
        const t = u as { used?: unknown; size?: unknown };
        return `◌ usage ${scalar(t.used)}/${scalar(t.size)}`;
      }
      case 'config_option_update': {
        const opts =
          (u.configOptions as { id?: string; currentValue?: unknown }[] | undefined) ?? [];
        return `config ${opts.map(o => `${safe(o.id ?? '?')}=${safe(scalar(o.currentValue))}`).join(' ')}`;
      }
      case 'current_mode_update':
        return `mode → ${safe(scalar((u as { currentModeId?: unknown }).currentModeId))}`;
      case 'available_commands_update':
        return `${((u.availableCommands as unknown[] | undefined) ?? []).length} commands`;
      case 'session_info_update': {
        const title = (u as { title?: unknown }).title;
        return `session ${typeof title === 'string' && title !== '' ? safe(title) : '(info)'}`;
      }
      case 'subagent_update': {
        const s = u as { sessionId?: string; title?: string | null; description?: string | null };
        const desc =
          s.description != null && s.description !== '' ? ` — ${safe(s.description)}` : '';
        return `⎇ subagent ${safe(s.title ?? s.sessionId ?? '?')}${desc}`;
      }
      default:
        return `[${safe(u.sessionUpdate)}]`;
    }
  }

  /** The oldest items evict past MAX_ITEMS — the emitted ids let the
   *  shell destroyRecursively. */
  private evict(): void {
    const over = this.items.length - MAX_ITEMS;
    if (over <= 0) return;
    const drop = this.items.splice(0, over).map(i => i.id);
    this.ops.push({ op: 'evict', ids: drop });
  }

  /** Collapse/expand a tool card — the shell's selection key. */
  toggle(toolCallId: string): void {
    const rec = this.tools.get(toolCallId);
    if (rec === undefined) return;
    rec.item.collapsed = !rec.item.collapsed;
    this.ops.push({ op: 'tool', item: rec.item });
  }

  /** A plain-text projection of the tree — the `--dump` mode and the
   *  tests' readout. Mirrors the line renderer's shapes so a dump is
   *  already a readable session. */
  dump(): string[] {
    return dumpItems(this.items);
  }
}

/** The item list → plain dump lines, shared by every impl's dump()
 *  — a dump is a snapshot, not the live pane, so there are no caps. */
export function dumpItems(items: readonly Item[]): string[] {
  const lines: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'message':
      case 'thought':
        for (const l of it.text.split('\n')) lines.push(clip(l));
        break;
      case 'prompt':
        if (it.text === '') {
          lines.push('▸ prompt unavailable');
          break;
        }
        for (const l of it.text.split('\n')) lines.push(`▸ ${clip(l)}`);
        break;
      case 'tool': {
        const glyph = it.status === 'completed' ? '✓' : it.status === 'failed' ? '✗' : '⣿';
        const head = `${glyph} ${clip(it.title)}`;
        const kind = it.toolKind !== undefined && it.toolKind !== '' ? ` [${it.toolKind}]` : '';
        const argText = it.arg !== undefined ? firstLine(it.arg) : '';
        const arg = argText !== '' ? ` ${clip(argText, 120 - head.length - kind.length)}` : '';
        lines.push(`${head}${kind}${arg}`);
        if (it.bodyLanded && !it.collapsed) {
          for (const l of dumpContent(it.content)) lines.push(`│  ${l}`);
        }
        break;
      }
      default:
        for (const l of it.text.split('\n')) lines.push(clip(l));
    }
  }
  return lines;
}

/** One content item → plain card lines for dump()/tests — text block,
 *  diff `─ path` + `-`/`+`, terminal note, unknown bracket. No caps
 *  here: a dump is a snapshot, not the live pane. */
export function dumpContent(content: ToolContent[]): string[] {
  const lines: string[] = [];
  for (const c of content) {
    switch (c.kind) {
      case 'text':
        for (const l of c.text.split('\n')) lines.push(clip(l));
        break;
      case 'diff': {
        lines.push(`─ ${clip(c.path)}`);
        if (c.old !== undefined) for (const l of c.old.split('\n')) lines.push(`- ${clip(l)}`);
        if (c.cur !== undefined) for (const l of c.cur.split('\n')) lines.push(`+ ${clip(l)}`);
        break;
      }
      case 'terminal':
        lines.push(`terminal output is not archived (terminal ${c.id})`);
        break;
      case 'unknown':
        lines.push(`[${c.type}]`);
        break;
    }
  }
  return lines;
}

/** One item → its FULL raw text for the clipboard (Ctrl+C): text
 *  as-is, tools as `title\n<every content line>` — no display clip,
 *  no fold gate: copy always gets the whole card. */
export function copyItem(it: Item): string {
  if (it.kind === 'tool') {
    const head = `${it.title}${it.toolKind !== undefined && it.toolKind !== '' ? ` [${it.toolKind}]` : ''}${it.arg !== undefined ? ` ${it.arg}` : ''}`;
    return [head, ...dumpContent(it.content)].join('\n');
  }
  return it.text;
}
