/** Our own control kit — the row language we studied in their
 *  `conversation/` layer, reimplemented against our theme (addendum
 *  6: no git dependency — their layout lives in our code now, never
 *  an import). Every acp-impl item carries its source `Item` on `vi`;
 *  the view calls `acpLine` per row and paints the segments. */

import { theme } from '../theme.ts';
import type {
  MarkerItem,
  PermissionRecordItem,
  PlanItem,
  Item as TheirItem,
  ThoughtItem,
  ToolCallItem,
} from '../vendor/acp-model/src/index.ts';

/** One painted cell — `token` names the semantic role (theme resolves
 *  it), `fill` names a surface role for the cell/row background. */
export interface Segment {
  text: string;
  token: string;
  fill?: string;
}

/** One expanded-body row — `fill` washes the whole row (diff lines). */
export interface CardLine {
  segments: Segment[];
  fill?: string;
}

/** The token → paint table (our theme, their roles). */
interface SegStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}

const TOKENS: Record<string, SegStyle> = {
  'glyph.ok': { fg: theme.success },
  'glyph.err': { fg: theme.error },
  'glyph.live': { fg: theme.warning },
  kind: { fg: theme.muted },
  title: { fg: theme.text },
  arg: { fg: theme.muted, dim: true },
  tail: { fg: theme.muted, dim: true },
  marker: { fg: theme.muted, dim: true },
  thought: { fg: theme.muted, italic: true, dim: true },
  'diff.path': { fg: theme.accent },
  'diff.add': { fg: theme.success },
  'diff.del': { fg: theme.error },
  warn: { fg: theme.warning },
};

/** Row-fill surfaces — diff added/removed washes (dark tints that sit
 *  under the default bg, their `diff.added.bg`/`diff.removed.bg`). */
const FILLS: Record<string, string> = {
  'diff.add.bg': '#16321f',
  'diff.del.bg': '#3a1f24',
};

/** A `CardLine`/`Segment` fill name → the row's bg color. */
export const fillColor = (name: string): string | undefined => FILLS[name];

/** A segment's paint: token → fg style; `fill` → bg. */
export const segStyle = (seg: Segment): SegStyle => {
  const style = { ...(TOKENS[seg.token] ?? {}) };
  if (seg.fill !== undefined) {
    const bg = FILLS[seg.fill];
    if (bg !== undefined) style.bg = bg;
  }
  return style;
};

/** Segments → plain text — the `--dump` readout's row. */
export const lineText = (segs: readonly Segment[]): string => segs.map(s => s.text).join('');

/** The live spinner — their braille cadence, our frame set. */
const LIVE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TOOL_GLYPH: Record<string, { text: string; token: string }> = {
  completed: { text: '✓', token: 'glyph.ok' },
  failed: { text: '✗', token: 'glyph.err' },
  cancelled: { text: '✗', token: 'glyph.err' },
};

const clipTo = (s: string, w: number): string =>
  s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`;

const firstLine = (s: string): string => {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
};

/** `$ ⣿ execute  Bash  arg …           #1` — status glyph, wire kind,
 *  title, clipped arg, right-aligned tail. Their one-liner language. */
const toolLine = (item: ToolCallItem, width: number, frame: number, arg?: string): Segment[] => {
  const live = item.toolStatus === 'in_progress' || item.toolStatus === 'pending';
  const g = live
    ? { text: LIVE[frame % LIVE.length] ?? '⠋', token: 'glyph.live' }
    : (TOOL_GLYPH[item.toolStatus] ?? { text: '○', token: 'marker' });
  const segs: Segment[] = [
    { text: '$ ', token: 'marker' },
    { text: `${g.text} `, token: g.token },
    { text: item.toolKind ?? 'tool', token: 'kind' },
    { text: '  ', token: 'marker' },
    { text: item.title === '' ? (item.toolName ?? 'tool') : item.title, token: 'title' },
  ];
  const head1 = arg === undefined ? '' : firstLine(arg).trim();
  if (head1 !== '') segs.push({ text: `  ${head1}`, token: 'arg' });
  const tail = ` #${item.index}`;
  const head = lineText(segs);
  if (head.length + tail.length > width) {
    const room = Math.max(0, width - tail.length);
    return [
      { text: clipTo(head, room), token: 'title' },
      { text: tail, token: 'tail' },
    ];
  }
  segs.push({ text: ' '.repeat(width - head.length - tail.length), token: 'marker' });
  segs.push({ text: tail, token: 'tail' });
  return segs;
};

/** `∴ thinking…` — one dim-italic row, first line only. */
const thoughtLine = (item: ThoughtItem, width: number): Segment[] => [
  { text: '∴ ', token: 'marker' },
  { text: clipTo(firstLine(item.text).trim() || 'thinking…', width - 2), token: 'thought' },
];

/** `◈ plan 3/7` — the checklist as one count, entries live in the
 *  side item's own rendering when expanded detail matters. */
const planLine = (item: PlanItem, _width: number): Segment[] => {
  const done = item.entries.filter(e => e.status === 'completed').length;
  return [
    { text: '◈ ', token: 'marker' },
    { text: 'plan ', token: 'kind' },
    { text: `${done}/${item.entries.length}`, token: 'title' },
  ];
};

const OUTCOME: Record<string, string> = {
  allow_once: 'allow once',
  allow_always: 'allow always',
  reject_once: 'reject once',
  reject_always: 'reject always',
};

/** `⚠ permission ‹Bash› — allow once` — points at the interactive
 *  terminal, never approves itself. */
const permissionLine = (
  item: PermissionRecordItem,
  _width: number,
  _find: (toolCallId: string) => unknown
): Segment[] => {
  const o = item.outcome;
  const label =
    o.type === 'answered'
      ? (OUTCOME[o.optionKind] ?? o.optionKind)
      : o.type === 'withdrawn'
        ? 'withdrawn'
        : o.type === 'pending'
          ? 'pending — open a terminal to handle'
          : 'denied';
  return [
    { text: '⚠ ', token: 'warn' },
    { text: 'permission ', token: 'kind' },
    { text: `‹${item.title}›`, token: 'title' },
    { text: ` — ${label}`, token: 'arg' },
  ];
};

/** `end turn · 45.4s` — the compact boundary line, their confirmed
 *  density (elapsed beats our `── turn complete ──` banner). */
type TurnEndMarker = Extract<MarkerItem, { markerKind: 'turn_end' }>;

const turnEndLine = (item: TurnEndMarker, _width: number): Segment[] => {
  const secs = (item.durationMs / 1000).toFixed(1);
  return [
    { text: 'end turn ', token: 'marker' },
    { text: `· ${secs}s`, token: 'tail' },
    { text: ` · ${item.stopReason}`, token: 'arg' },
  ];
};

/** The row dispatcher — their Item union → its one-line row, or []
 *  for kinds the segment language doesn't draw (messages render
 *  through the shared markdown path). */
export const acpLine = (
  vi: unknown,
  width: number,
  frame: number,
  findTool: (toolCallId: string) => unknown,
  arg?: string
): readonly Segment[] => {
  const item = vi as TheirItem;
  const w = Math.max(20, width);
  switch (item.kind) {
    case 'tool_call':
      return toolLine(item, w, frame, arg);
    case 'thought':
      return thoughtLine(item, w);
    case 'plan':
      return planLine(item, w);
    case 'permission_record':
      return permissionLine(item, w, findTool);
    case 'marker':
      return item.markerKind === 'turn_end' ? turnEndLine(item, w) : [];
    default:
      return [];
  }
};

const isJsonDocument = (text: string): boolean => {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

/** The expanded tool body — our card language: numbered diff hunks
 *  with added/removed row fills, the terminal notice, a blank row
 *  between blocks, `▸ JSON` for pure-JSON results. */
export const acpCardRows = (vi: unknown, width: number): CardLine[] => {
  const item = vi as TheirItem;
  if (item.kind !== 'tool_call') return [];
  const w = Math.max(20, width);
  const allJson =
    item.content.length > 0 && item.content.every(c => c.type === 'text' && isJsonDocument(c.text));
  if (allJson) {
    return [{ segments: [{ text: '▸ JSON', token: 'arg' }] }];
  }
  const rows: CardLine[] = [];
  const blank = (): void => {
    if ((rows.at(-1)?.segments.length ?? 0) > 0) rows.push({ segments: [] });
  };
  for (const c of item.content) {
    if (c.type === 'diff') {
      blank();
      rows.push({ segments: [{ text: c.path, token: 'diff.path' }] });
      const oldLines = (c.oldText ?? '').split('\n').filter(l => l !== '');
      const newLines = c.newText.split('\n').filter(l => l !== '');
      oldLines.forEach((l, i) => {
        rows.push({
          fill: 'diff.del.bg',
          segments: [
            { text: `-${String(i + 1).padStart(3)} `, token: 'diff.del' },
            { text: clipTo(l, w - 5), token: 'diff.del' },
          ],
        });
      });
      newLines.forEach((l, i) => {
        rows.push({
          fill: 'diff.add.bg',
          segments: [
            { text: `+${String(i + 1).padStart(3)} `, token: 'diff.add' },
            { text: clipTo(l, w - 5), token: 'diff.add' },
          ],
        });
      });
    } else if (c.type === 'terminal_unavailable') {
      blank();
      rows.push({
        segments: [{ text: '▸ terminal output unavailable', token: 'arg' }],
      });
    } else if (c.type === 'text') {
      blank();
      for (const l of c.text.split('\n')) {
        rows.push({ segments: [{ text: clipTo(l, w), token: 'title' }] });
      }
    }
  }
  return rows;
};

/** Their `list.ts` grouping, our item vocabulary: user / agent /
 *  activity / plan / marker. Legacy items map by kind — geometry is
 *  shared, vocabulary stays per-impl. */
export type ItemGroup = 'user' | 'agent' | 'activity' | 'plan' | 'marker';

export const itemGroup = (item: { kind: string; vi?: unknown }): ItemGroup => {
  const vi = item.vi as TheirItem | undefined;
  if (vi !== undefined) {
    switch (vi.kind) {
      case 'user_message':
        return 'user';
      case 'agent_message':
        return 'agent';
      case 'plan':
        return 'plan';
      case 'marker':
      case 'permission_record':
        return 'marker';
      default:
        return 'activity';
    }
  }
  switch (item.kind) {
    case 'prompt':
      return 'user';
    case 'message':
      return 'agent';
    case 'turn':
    case 'permission':
      return 'marker';
    default:
      return 'activity';
  }
};

/** Their spacing rule: a blank row before user/agent text and on any
 *  group change; activity stays tight. */
export const spacingBefore = (prev: ItemGroup, next: ItemGroup): number =>
  prev === next && next !== 'user' && next !== 'agent' ? 0 : 1;
