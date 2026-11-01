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

/** A text block past this many lines folds by default — the row
 *  shows a `+N lines` summary instead of dumping the whole block
 *  (addendum 20: a 300-line review thread must never take the
 *  screen unpinned). */
export const FOLD_TEXT_AT = 8;

/** The fold thresholds by kind — prompt/note dumps fold tight, but
 *  agent prose is the pane's content and stays open until it is
 *  truly long (addendum 20). */
const FOLDABLE_AT: Record<string, number> = {
  prompt: FOLD_TEXT_AT,
  note: FOLD_TEXT_AT,
  message: 40,
  thought: 40,
};

/** Can the row carry a fold? Tools always can; text items can once
 *  they pass their kind's threshold (or are already collapsed). */
export function isFoldable(item: Item): boolean {
  if (item.kind === 'tool') return true;
  const at = FOLDABLE_AT[item.kind];
  return (
    at !== undefined &&
    (item.collapsed === true || ('text' in item && item.text.split('\n').length > at))
  );
}

/** May the item leave the live strip for scrollback? Settled items
 *  will never paint again: a terminal tool, any settled one-liner —
 *  and a message/thought only once it is no longer the tail item,
 *  since the open chunk keeps absorbing text. In-flight rows stay
 *  live so updates keep repainting them. */
export function isSettled(item: Item, isLast: boolean): boolean {
  if (item.kind === 'tool') return item.status !== 'live';
  if (item.kind === 'message' || item.kind === 'thought') return !isLast;
  return true;
}

/** Markdown → plain text for the captured-stdout scrollback path
 *  and the collapsed previews: markers conceal (the renderable's
 *  `conceal` equivalent), links print `text (url)`, fences drop to
 *  indented code, HTML tags vanish. Raw `**`/`<details>` literals
 *  never reach the pane (addendum 20). */
export function mdPlain(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(`    ${raw}`);
      continue;
    }
    out.push(
      raw
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
        .replace(/\[\/\/\]:\s*#\s*\(.*\)/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*>\s?/, '  ')
        .replace(/<[^>]+>/g, '')
    );
  }
  return out;
}

/* ── Scrollback styling ───────────────────────────────────────────
 * Captured stdout is the ONLY path into herdr scrollback — and it
 * carries real ANSI, so retired rows keep the pane's formatting:
 * truecolor foregrounds from the same theme tokens, SGR bold/dim/
 * underline. `mdStyled` is the stdout equivalent of the
 * renderable's `<markdown conceal>` — markers never survive. */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const UNDER = `${ESC}4m`;

/** `#rrggbb` → a truecolor SGR foreground. */
const fg = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${ESC}38;2;${r};${g};${b}m`;
};

const C = {
  muted: fg(theme.muted),
  emph: fg(theme.emph),
  peach: fg(theme.peach),
  amber: fg(theme.amber),
  cyan: fg(theme.cyan),
  success: fg(theme.success),
  error: fg(theme.error),
  warning: fg(theme.warning),
} as const;

/** Markdown → ANSI-styled lines for the scroll region — headings
 *  go bold-emph, bold goes bold, links go cyan-underline `t (u)`,
 *  inline code goes cyan, fences keep their body as muted indented
 *  code, HTML tags vanish. Same transforms as mdPlain + SGR. */
export function mdStyled(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(`${C.muted}    ${raw}${RESET}`);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+/.test(raw);
    const quote = /^\s*>\s?/.test(raw);
    const l = raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, `${C.cyan}${UNDER}$1${RESET}${C.muted} ($2)${RESET}`)
      .replace(/\[\/\/\]:\s*#\s*\(.*\)/g, '')
      .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
      .replace(/__([^_]+)__/g, `${BOLD}$1${RESET}`)
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, `${C.cyan}$1${RESET}`)
      .replace(/<[^>]+>/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, `${C.muted}┃ ${RESET}`);
    void quote;
    out.push(heading ? `${BOLD}${C.emph}${l}${RESET}` : l);
  }
  return out;
}

/** The line form a row prints to the scroll region as — the same
 *  grammar the tree paints: `┃` prompt block, `⏺` tool/message,
 *  `+ Thought`, `──` markers, `▸` header, and a ≤3-line + `+N more`
 *  body under an open call. Plain text — the scroll region is a
 *  captured-stdout feed, not a renderable surface. */
/** The tool row's meaningful tail — ` [kind]` only where the kind
 *  adds signal (a `command`/`grep` title already says `execute`),
 *  then the arg's first line unless it merely repeats the title or
 *  is the call's cwd. Diff content tallies as `+a −b`. */
export function toolTail(item: ToolItem): { kind: string; arg: string; tally: string } {
  const kind =
    item.toolKind !== undefined && item.toolKind !== '' && item.toolKind !== 'execute'
      ? ` [${item.toolKind}]`
      : '';
  let arg = argHead(item);
  const first = item.arg !== undefined ? firstLine(item.arg) : '';
  if (
    arg === '' ||
    item.title.includes(first) ||
    (item.toolKind === 'execute' && first.startsWith('/'))
  ) {
    arg = '';
  } else {
    arg = ` ${arg}`;
  }
  let add = 0;
  let del = 0;
  for (const c of item.content) {
    if (c.kind === 'diff') {
      del += (c.old ?? '').split('\n').filter(l => l !== '').length;
      add += (c.cur ?? '').split('\n').filter(l => l !== '').length;
    }
  }
  const tally = add + del > 0 ? ` +${add} −${del}` : '';
  return { kind, arg, tally };
}

export function printLines(item: Item): string[] {
  const stamp = `${C.muted}${item.at !== undefined ? `${hhmm(item.at)} ` : '     '}${RESET}`;
  const rows = (lines: string[]): string[] =>
    lines.map((l, i) => `${i === 0 ? stamp : '      '}${l}`);
  const folded = item.collapsed === true;
  const more = 'text' in item ? item.text.split('\n').length : 0;
  switch (item.kind) {
    case 'header':
      return rows([`${C.emph} ▸ ${item.text}${RESET}`]);
    case 'prompt':
      return folded
        ? rows([
            `${C.peach}┃${RESET}`,
            `${C.peach}┃${RESET}  Prompt`,
            `${C.peach}┃${RESET}  ${C.muted}+${more} lines${RESET}`,
            `${C.peach}┃${RESET}`,
          ])
        : rows([
            `${C.peach}┃${RESET}`,
            `${C.peach}┃${RESET}  ${C.muted}Prompt${RESET}`,
            `${C.peach}┃${RESET}`,
            ...mdStyled(item.text).map(l => `${C.peach}┃${RESET}  ${l}`),
            `${C.peach}┃${RESET}`,
          ]);
    case 'message':
      return folded
        ? rows([
            `${C.peach}⏺${RESET} ${C.muted}${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines${RESET}`,
          ])
        : rows(
            mdStyled(item.text).map((l, i) => (i === 0 ? `${C.peach}⏺${RESET} ${l}` : `  ${l}`))
          );
    case 'thought':
      return folded
        ? rows([
            `${C.amber}+ Thought${RESET}${C.muted} · ${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines${RESET}`,
          ])
        : rows([
            `${C.amber}+ Thought${RESET}`,
            ...mdStyled(item.text).map(l => `  ${C.muted}${l}${RESET}`),
          ]);
    case 'tool': {
      const g =
        item.status === 'completed'
          ? `${C.success}✓${RESET}`
          : item.status === 'live'
            ? `${C.warning}…${RESET}`
            : `${C.error}✗${RESET}`;
      const tail = toolTail(item);
      const head = `${C.muted}⏺${RESET} ${g} ${C.muted}${item.title}${tail.kind}${tail.arg}${RESET}${tail.tally !== '' ? `${C.muted}${tail.tally}${RESET}` : ''}`;
      const out = [head];
      // collapsed = the row only — file dumps never print (the user
      // asked for opencode's quiet mass row); open shows the body
      if (!folded) {
        const body = toolBodyLines(item, Number.POSITIVE_INFINITY);
        for (const l of body.lines) {
          out.push(
            l.startsWith('+ ')
              ? `  ${C.success}${l}${RESET}`
              : l.startsWith('- ')
                ? `  ${C.error}${l}${RESET}`
                : `  ${C.muted}${l}${RESET}`
          );
        }
      }
      return rows(out);
    }
    default:
      return folded
        ? rows([`${C.muted}${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines${RESET}`])
        : rows(mdStyled(item.text));
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

/** The card body as markdown for the pinned-open view — text
 *  content passes through as real markdown (the `<markdown>`
 *  renderable formats it), diffs become ```` ```diff ```` fences so
 *  the tree-sitter path highlights them, and the rest degrades to
 *  plain notes (addendum 20). */
export function toolBodyMd(item: ToolItem): string {
  const out: string[] = [];
  const arg = argBody(item);
  if (arg !== undefined) out.push('```sh', arg, '```');
  for (const c of item.content) {
    if (c.kind === 'text') {
      if (EMPTY_OUTPUT.test(c.text)) continue;
      out.push(c.text);
    } else if (c.kind === 'diff') {
      out.push(
        '```diff',
        `─ ${c.path}`,
        ...(c.old ?? '').split('\n').map(l => `-${l}`),
        ...(c.cur ?? '').split('\n').map(l => `+${l}`),
        '```'
      );
    } else if (c.kind === 'terminal') {
      out.push(`terminal output is not archived (terminal ${c.id})`);
    } else {
      out.push(`[${c.type}]`);
    }
  }
  return out.join('\n');
}

/** The unified diff text a patch renders as — the two sides
 *  synthesized, since an archive patch carries old and new text
 *  rather than a diff. */
export function diffText(content: Extract<ToolContent, { kind: 'diff' }>): string {
  const old = (content.old ?? '').split('\n').map(l => `-${l}`);
  const cur = (content.cur ?? '').split('\n').map(l => `+${l}`);
  return `--- a/${content.path}\n+++ b/${content.path}\n@@ -1,${old.length} +1,${cur.length} @@\n${[...old, ...cur].join('\n')}\n`;
}
