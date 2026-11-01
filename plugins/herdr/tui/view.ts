/**
 * The session pane's view helpers (spec bro-q2edc) — the pure text
 * the tree renders, with no renderables and no framework.
 *
 * These live apart from `app.tsx` so they stay testable without a
 * terminal: the tree is Bun-only (native FFI), the formatting is not.
 */
import { clip, firstLine } from '../../../packages/providers/src/acp-render.ts';
import type { Item, ToolContent, ToolItem, ToolStatus } from './model.ts';
import { theme } from './theme.ts';

/** The arg's header segment — its first meaningful line clipped to
 *  the budget the row leaves (a multiline arg — a heredoc — is a
 *  body block, never a `⏎` mash in the header). */
export function argHead(item: ToolItem, width = 60): string {
  if (item.arg === undefined) return '';
  const first = firstLine(item.arg);
  return first !== '' ? clip(first, width) : '';
}

/** The arg's body form — the full block when it spans lines (a
 *  heredoc's command renders across the card body, real breaks).
 *  Single-line args stay in the header only — no echo. */
export function argBody(item: ToolItem): string | undefined {
  if (item.arg === undefined || !item.arg.includes('\n')) return undefined;
  return item.arg;
}

/** The card border color — a failed tool reads red, a done one green,
 *  a live one the warning accent (it is still working). */
export function cardBorderColor(status: ToolStatus, selected: boolean): string {
  if (selected) return theme.accent;
  if (status === 'failed') return theme.error;
  if (status === 'completed') return theme.success;
  return theme.warning;
}

/** The card glyph's color — status-colored like the border. */
export function cardGlyphColor(status: ToolStatus): string {
  if (status === 'failed') return theme.error;
  if (status === 'completed') return theme.success;
  return theme.warning;
}

/** A side item's color from its tone — warn/error accents, dim the
 *  rest (turn dividers, plan blocks, unknown one-liners). */
export function sideColor(tone: 'warn' | 'error' | undefined): string {
  if (tone === 'warn') return theme.warning;
  if (tone === 'error') return theme.error;
  return theme.muted;
}

/** The body line count a card would render — the auto-fold threshold
 *  and the `… N more` hint's tally. */
export function contentLineCount(item: ToolItem): number {
  let n = 0;
  for (const c of item.content) {
    if (c.kind === 'text') n += c.text.split('\n').length;
    else if (c.kind === 'diff')
      n += 1 + (c.old?.split('\n').length ?? 0) + (c.cur?.split('\n').length ?? 0);
    else n += 1;
  }
  const arg = argBody(item);
  if (arg !== undefined) n += arg.split('\n').length;
  return n;
}

/** `at` → the `HH:MM` gutter stamp (local time — the reader's
 *  clock, not the journal's UTC). Missing stamps render nothing. */
export const hhmm = (at: string | undefined): string => {
  if (at === undefined) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Rows the live tail keeps in the footer strip — older items are
 *  retired: printed to captured stdout (the terminal's scroll
 *  region → real scrollback) and evicted from the tree (addendum
 *  19: the retained tree in ANY screen mode can only show a
 *  viewport's worth; scrollback is where history must live). */
export const TAIL_BUDGET = 15;

/** The line form a row prints to the scroll region as — the same
 *  grammar the tree paints: `┃` prompt block, `⏺` tool/message,
 *  `+ Thought`, `──` markers, `▸` header, and a ≤3-line + `+N more`
 *  body under an open call. Plain text — the scroll region is a
 *  captured-stdout feed, not a renderable surface. */
export function printLines(item: Item): string[] {
  const stamp = item.at !== undefined ? `${hhmm(item.at)} ` : '      ';
  const rows = (lines: string[]): string[] =>
    lines.map((l, i) => `${i === 0 ? stamp : '      '}${l}`);
  switch (item.kind) {
    case 'header':
      return rows([` ▸ ${item.text}`]);
    case 'prompt':
      return rows(['┃', '┃  Prompt', '┃', ...item.text.split('\n').map(l => `┃  ${l}`), '┃']);
    case 'message':
      return rows(item.text.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)));
    case 'thought':
      return rows([`+ Thought · ${firstLine(item.text)}`]);
    case 'tool': {
      const g = item.status === 'completed' ? '✓' : item.status === 'live' ? '…' : '✗';
      const kind = item.toolKind !== undefined && item.toolKind !== '' ? ` [${item.toolKind}]` : '';
      const arg = argHead(item, 120);
      const head = `⏺ ${g} ${item.title}${kind}${arg !== '' ? ` ${arg}` : ''}`;
      const out = [head];
      if (!item.collapsed) {
        const body = toolBodyLines(item);
        for (const l of body.lines) out.push(`  ${l}`);
        if (body.more > 0) out.push(`  +${body.more} more`);
      }
      return rows(out);
    }
    default:
      return rows(item.text.split('\n'));
  }
}

/** The tail height an item occupies — its printed line count
 *  approximates its rendered rows (compact rows are exact; wrapped
 *  prose can drift a row, and the tail budget carries slack). */
export const rowHeight = (item: Item): number => printLines(item).length;

/** Output that carries nothing — an agent reporting `(no output)` or
 *  whitespace is a silent row, and silent rows never paint. */
const EMPTY_OUTPUT = /^\s*(?:\(no output\))?\s*$/;

/** The card body as plain lines — arg block (a heredoc command)
 *  then every content entry flattened like dumpContent, minus the
 *  noise: `(no output)` results and blank lines are dropped, never
 *  a row. Capped for the under-call preview — `more` counts what
 *  the cap hid (the `+N more` row). */
export function toolBodyLines(item: ToolItem, max = 3): { lines: string[]; more: number } {
  const all: string[] = [];
  const arg = argBody(item);
  if (arg !== undefined) all.push(...arg.split('\n'));
  for (const c of item.content) {
    if (c.kind === 'text') {
      if (EMPTY_OUTPUT.test(c.text)) continue;
      for (const l of c.text.split('\n')) if (l !== '') all.push(l);
    } else if (c.kind === 'diff') {
      all.push(`─ ${c.path}`);
      for (const l of (c.old ?? '').split('\n')) if (l !== '') all.push(`- ${l}`);
      for (const l of (c.cur ?? '').split('\n')) if (l !== '') all.push(`+ ${l}`);
    } else if (c.kind === 'terminal') {
      all.push(`terminal output is not archived (terminal ${c.id})`);
    } else {
      all.push(`[${c.type}]`);
    }
  }
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The unified diff text a patch renders as — the two sides
 *  synthesized, since an archive patch carries old and new text
 *  rather than a diff. */
export function diffText(content: Extract<ToolContent, { kind: 'diff' }>): string {
  const old = (content.old ?? '').split('\n').map(l => `-${l}`);
  const cur = (content.cur ?? '').split('\n').map(l => `+${l}`);
  return `--- a/${content.path}\n+++ b/${content.path}\n@@ -1,${old.length} +1,${cur.length} @@\n${[...old, ...cur].join('\n')}\n`;
}
