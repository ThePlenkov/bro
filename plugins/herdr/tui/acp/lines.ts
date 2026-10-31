/** The vendored row language — `format.ts`'s one-liners + `DEFAULT_THEME`'s
 *  palette, adapted onto our Item seam. Every acp-impl item carries its
 *  source `Item` on `vi`; the view calls `acpLine` per row and paints the
 *  segments — the card chrome is theirs, the shell stays ours. */

import type {
  MarkerItem,
  PermissionRecordItem,
  PlanItem,
  ThoughtItem,
  ToolCallItem,
} from 'acp-model';
import {
  permissionLine,
  planLine,
  thoughtLine,
  toolLine,
  turnEndLine,
} from '../vendor/acp-tui/packages/acp-tui/src/conversation/format.ts';
import { LIVE_GLYPHS } from '../vendor/acp-tui/packages/acp-tui/src/conversation/live-glyphs.ts';
import type { Segment } from '../vendor/acp-tui/packages/acp-tui/src/layout/segments.ts';
import { DEFAULT_THEME } from '../vendor/acp-tui/packages/acp-tui/src/theme/default-theme.ts';

export type { Segment };

/** The subset of their Item union this pane renders. */
type VItem =
  | ToolCallItem
  | ThoughtItem
  | PlanItem
  | PermissionRecordItem
  | MarkerItem
  | { kind: string };

/** Resolve the item's row — the same one-liners their conversation draws.
 *  `frame` drives the running-tool spinner; `findTool` links a permission
 *  row back to its tool call (the record alone only holds the outcome). */
export const acpLine = (
  vi: unknown,
  width: number,
  frame: number,
  findTool?: (toolCallId: string) => unknown
): readonly Segment[] => {
  const item = vi as VItem;
  switch (item.kind) {
    case 'tool_call':
      return toolLine(item as ToolCallItem, width, LIVE_GLYPHS, frame);
    case 'thought':
      return thoughtLine(item as ThoughtItem, width);
    case 'plan':
      return planLine((item as PlanItem).entries);
    case 'permission_record': {
      const record = item as PermissionRecordItem;
      const tool = findTool?.(record.toolCallId);
      return permissionLine(record, (tool as ToolCallItem | undefined) ?? null, width);
    }
    case 'marker': {
      const marker = item as MarkerItem;
      return marker.markerKind === 'turn_end'
        ? turnEndLine(marker as Extract<MarkerItem, { markerKind: 'turn_end' }>)
        : [];
    }
    default:
      return [];
  }
};

export type SegStyle = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
};

/** `TokenValue` is a hex/"default" string, a `{color, light, bold, …}`
 *  style object, or a one-hop `{ref}` alias. Dark-terminal `color` wins. */
const tokenStyle = (name: string, depth = 0): SegStyle => {
  const value = (DEFAULT_THEME.tokens as Record<string, unknown>)[name];
  if (value === undefined || value === null || depth > 3) return {};
  if (typeof value === 'string') return value === 'default' ? {} : { fg: value };
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.ref === 'string') return tokenStyle(o.ref, depth + 1);
    const style: SegStyle = {};
    if (typeof o.color === 'string' && o.color !== 'default') style.fg = o.color;
    if (o.bold === true) style.bold = true;
    if (o.italic === true) style.italic = true;
    if (o.dim === true) style.dim = true;
    return style;
  }
  return {};
};

/** A segment's paint: token → fg style; `fill` (a surface token) → bg. */
export const segStyle = (seg: Segment): SegStyle => {
  const style = tokenStyle(seg.token);
  if (seg.fill !== undefined) {
    const bg = tokenStyle(seg.fill).fg;
    if (bg !== undefined) style.bg = bg;
  }
  return style;
};

/** Plain-text join — the dump/conformance readout's view of a row. */
export const lineText = (segments: readonly Segment[]): string =>
  segments
    .map(s => s.text)
    .join('')
    .trimEnd();
