/**
 * The session pane's view helpers (spec bro-q2edc) — the pure text
 * the tree renders, with no renderables and no framework.
 *
 * These live apart from `app.tsx` so they stay testable without a
 * terminal: the tree is Bun-only (native FFI), the formatting is not.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Item, ToolContent, ToolItem, ToolStatus } from '../model/items.ts';
import { clip, firstLine } from '../wire/index.ts';
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

/** The folded caller prompt keeps its first lines visible — enough
 *  to know what was asked without handing the block the screen
 *  (addendum 26). `BRO_TUI_PROMPT_PREVIEW` overrides; `0` restores
 *  the bare `+N lines` summary. */
const envPreview = Number.parseInt(process.env.BRO_TUI_PROMPT_PREVIEW ?? '', 10);
export const PROMPT_PREVIEW_LINES = Number.isNaN(envPreview) ? 5 : Math.max(0, envPreview);

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
    out.push(stripMarkdownLine(raw));
  }
  return out;
}

/** `open…close` spans out of a line — a linear scan, no regex (the
 *  scanner's injection/ReDoS flags). `keepUnclosed` preserves the
 *  tail from an unterminated `open` (a lone `<` was never a tag, so
 *  `a < b` survives); without it the tail is eaten to end-of-line
 *  (an unterminated `<!--` can never survive the pass). */
const stripDelims = (s: string, open: string, close: string, keepUnclosed: boolean): string => {
  let out = '';
  let rest = s;
  for (;;) {
    const i = rest.indexOf(open);
    if (i === -1) return out + rest;
    out += rest.slice(0, i);
    const j = rest.indexOf(close, i + open.length);
    if (j === -1) return keepUnclosed ? out + rest.slice(i) : out;
    rest = rest.slice(j + close.length);
  }
};

/** The inline markdown subset used by the plain-text view.  Each helper
 * makes one bounded linear pass.  This is deliberately not a collection of
 * regular expressions: malformed or hostile markdown must not make matching
 * revisit the same suffix exponentially. */
const stripMarkdownLine = (raw: string): string => {
  let line = stripTags(raw);
  line = stripHeading(line);
  line = stripLinkDefinition(line);
  line = stripLinks(line);
  line = stripDelimited(line, '**');
  line = stripDelimited(line, '__');
  line = stripDelimited(line, '*');
  line = stripUnderscores(line);
  line = stripDelimited(line, '~~');
  line = stripDelimited(line, '`');
  let indent = 0;
  while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) indent++;
  if (line[indent] === '>') {
    const skip = line[indent + 1] === ' ' ? 2 : 1;
    line = `${line.slice(0, indent)}  ${line.slice(indent + skip)}`;
  }
  // A delimiter can be exposed by removing a longer delimiter (***x***).
  // Three passes match the old replacement order without an unbounded loop.
  return stripDelimited(line, '*');
};

const stripHeading = (s: string): string => {
  let i = 0;
  while (i < s.length && i < 3 && s[i] === ' ') i++;
  const start = i;
  while (i < s.length && i - start < 6 && s[i] === '#') i++;
  return i > start && s[i] === ' ' ? s.slice(i + 1) : s;
};

const stripLinks = (s: string): string => {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const image = s.startsWith('![', i);
    const link = image || s[i] === '[';
    if (!link) {
      out += s[i++];
      continue;
    }
    const labelStart = i + (image ? 2 : 1);
    const labelEnd = s.indexOf(']', labelStart);
    const targetStart = labelEnd + 1;
    const targetEnd =
      labelEnd >= 0 && s[targetStart] === '(' ? s.indexOf(')', targetStart + 1) : -1;
    if (labelEnd < 0 || targetEnd < 0 || s.slice(labelStart, labelEnd).includes('!')) {
      out += s[i++];
      continue;
    }
    const label = s.slice(labelStart, labelEnd);
    if (image) out += label;
    else out += `${label} (${s.slice(targetStart + 1, targetEnd)})`;
    i = targetEnd + 1;
  }
  return out;
};

const stripLinkDefinition = (s: string): string => {
  const start = s.indexOf('[//]:');
  if (start < 0) return s;
  let i = start + 5;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] !== '#') return s;
  i++;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] !== '(') return s;
  const close = s.lastIndexOf(')');
  return close < i ? s : s.slice(0, start) + s.slice(close + 1);
};

const stripDelimited = (s: string, marker: string): string => {
  let out = '';
  let cursor = 0;
  let open = -1;
  for (let i = 0; i <= s.length - marker.length; i++) {
    if (!s.startsWith(marker, i)) continue;
    if (open < 0) {
      open = i;
      i += marker.length - 1;
      continue;
    }
    if (i === open + marker.length) {
      out += s.slice(cursor, i + marker.length);
    } else {
      out += s.slice(cursor, open) + s.slice(open + marker.length, i);
    }
    cursor = i + marker.length;
    open = -1;
    i += marker.length - 1;
  }
  return out + s.slice(cursor);
};

const stripUnderscores = (s: string): string => {
  let out = '';
  let cursor = 0;
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '_') continue;
    if (open < 0) {
      const before = i === 0 ? '' : s[i - 1]!;
      if (!isWord(before)) open = i;
      continue;
    }
    const after = i + 1 >= s.length ? '' : s[i + 1]!;
    if (i === open + 1 || isWord(after)) {
      out += s.slice(cursor, i + 1);
      cursor = i + 1;
      open = -1;
      continue;
    }
    out += s.slice(cursor, open) + s.slice(open + 1, i);
    cursor = i + 1;
    open = -1;
  }
  return out + s.slice(cursor);
};

const isWord = (char: string): boolean => {
  if (char === '') return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '_'
  );
};

/** HTML-looking tags out of a line — a linear scan, no regex: `<`
 *  opens a tag that runs to `>`; an unclosed `<` keeps its char (it
 *  was never a tag) so ordinary text like `a < b` survives. */
const stripTags = (s: string): string => {
  let out = '';
  let i = 0;
  for (;;) {
    const open = s.indexOf('<', i);
    if (open === -1) return out + s.slice(i);
    out += s.slice(i, open);
    const close = s.indexOf('>', open + 1);
    if (close === -1) return out + s.slice(open);
    i = close + 1;
  }
};

/** `<!-- ... -->` comments out of a line — a linear scan, no regex:
 *  an unterminated comment eats to end-of-line and no `<!--` can
 *  survive the pass (the scanner's injection/ReDoS flags). */
const stripHtmlComments = (s: string): string => {
  let out = '';
  let rest = s;
  for (;;) {
    const i = rest.indexOf(open);
    if (i === -1) return out + rest;
    out += rest.slice(0, i);
    const j = rest.indexOf(close, i + open.length);
    if (j === -1) return keepUnclosed ? out + rest.slice(i) : out;
    rest = rest.slice(j + close.length);
  }
};

/** HTML-looking tags out of a line — `<` opens a tag that runs to
 *  `>`; an unclosed `<` keeps its char so ordinary text survives. */
const stripTags = (s: string): string => stripDelims(s, '<', '>', true);

/** `<!-- ... -->` comments out of a line — an unterminated comment
 *  eats to end-of-line so no `<!--` can survive the pass. */
const stripHtmlComments = (s: string): string => stripDelims(s, '<!--', '-->', false);

/** HTML-looking tags out of a line — `<` opens a tag that runs to
 *  `>`; an unclosed `<` keeps its char so ordinary text survives. */
const stripTags = (s: string): string => stripDelims(s, '<', '>', true);

/** `<!-- ... -->` comments out of a line — an unterminated comment
 *  eats to end-of-line so no `<!--` can survive the pass. */
const stripHtmlComments = (s: string): string => stripDelims(s, '<!--', '-->', false);

/** Markdown source for the `<markdown>` renderable — the renderable
 *  prints raw HTML tags literally, so review-tool furniture
 *  (`<sub>`, `</review-threads>`, `<details>` wrappers, comments)
 *  strips here the same way `mdPlain` strips it for text. Fenced
 *  code keeps its tags — `</div>` in a snippet is real code. */
export function mdSource(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      out.push(raw);
      continue;
    }
    out.push(
      fence
        ? raw
        : stripHtmlComments(raw).replace(/<\/?(?:sub|details|summary|review-threads?)\b[^>]*>/g, '')
    );
  }
  return out.join('\n');
}

/* ── Scroll region is PLAIN TEXT ──────────────────────────────────
 * Captured stdout is the ONLY path into herdr scrollback, and the
 * capture path escapes the ESC byte — so emitted ANSI surfaces as
 * literal `[38;2;…` garbage (field-found). The scroll region can
 * therefore only ever carry clean plain text; real markdown, colors
 * and fences live in the renderable footer strip. `printLines` is the
 * stdout equivalent of the tree's grammar — compact rows, no styling. */

/** The tool row's meaningful tail — ` [kind]` only where the kind
 *  adds signal (a `command`/`grep` title already says `execute`),
 *  then the arg's first line unless it merely repeats the title or
 *  is the call's cwd. Diff content tallies as `+a −b`. */
export function toolTail(item: ToolItem): { kind: string; arg: string; tally: string } {
  return { kind: tailKind(item), arg: tailArg(item), tally: tailTally(item) };
}

/** Kinds that add no signal — a `command`/`grep` title already says
 *  `execute`, and the empty kind says nothing. */
const TAIL_KIND_DROP: ReadonlySet<string> = new Set(['', 'execute']);

const tailKind = (item: ToolItem): string => {
  const k = item.toolKind;
  return k === undefined || TAIL_KIND_DROP.has(k) ? '' : ` [${k}]`;
};

/** The arg's first line — dropped when it merely repeats the title
 *  or is an `execute` call's cwd. */
const tailArg = (item: ToolItem): string => {
  const head = argHead(item);
  if (head === '') return '';
  const first = item.arg !== undefined ? firstLine(item.arg) : '';
  if (item.title.includes(first)) return '';
  if (item.toolKind === 'execute' && first.startsWith('/')) return '';
  return ` ${head}`;
};

/** The diff tally — ` +a −b` when the body carries hunks. */
const tailTally = (item: ToolItem): string => {
  let add = 0;
  let del = 0;
  for (const c of item.content) {
    if (c.kind === 'diff') {
      del += (c.old ?? '').split('\n').filter(l => l !== '').length;
      add += (c.cur ?? '').split('\n').filter(l => l !== '').length;
    }
  }
  return add + del > 0 ? ` +${add} −${del}` : '';
};
export function printLines(item: Item): string[] /* NOSONAR typescript:S3776 */ {
  const rows = (lines: string[]): string[] => lines;
  const folded = item.collapsed === true;
  const more = 'text' in item ? item.text.split('\n').length : 0;
  switch (item.kind) {
    case 'header':
      return rows([` ▸ ${item.text}`]);
    case 'prompt': {
      const ls = mdPlain(item.text);
      if (!folded) return rows(['┃', ...ls.map(l => `┃ ${l}`), '┃']);
      const shown = ls.slice(0, PROMPT_PREVIEW_LINES);
      return rows(['┃', ...shown.map(l => `┃ ${l}`), `┃ +${ls.length - shown.length} lines`, '┃']);
    }
    case 'message':
      return folded
        ? rows([`  ${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines`])
        : rows(mdPlain(item.text).map(l => `  ${l}`));
    case 'thought':
      return folded
        ? rows([`+ Thought · ${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines`])
        : rows([`+ Thought`, ...mdPlain(item.text).map(l => `  ${l}`)]);
    case 'tool': {
      const g = item.status === 'completed' ? '✓' : item.status === 'live' ? '…' : '✗';
      const tail = toolTail(item);
      const head = `${g} ${item.title}${tail.kind}${tail.arg}${tail.tally}`;
      const out = [head];
      // a collapsed row is just the head — generated file/output bodies
      // never dump into the feed. An open row prints a capped preview
      // (≤3 lines + `+N more`) — enough signal, never a file dump.
      if (!folded) {
        const body = toolBodyLines(item, 3);
        for (const l of body.lines) out.push(`  ${l}`);
        if (body.more > 0) out.push(`  +${body.more} more`);
      }
      return rows(out);
    }
    default:
      return folded
        ? rows([`${firstLine(mdPlain(item.text).join('\n'))} · +${more} lines`])
        : rows(mdPlain(item.text));
  }
}

/** The tail height an item occupies — its printed line count
 *  approximates its rendered rows (compact rows are exact; wrapped
 *  prose can drift a row, and the tail budget carries slack). */
export const rowHeight = (item: Item): number => printLines(item).length;

/** Output that carries nothing — an agent reporting `(no output)` or
 *  whitespace is a silent row, and silent rows never paint. */
const EMPTY_OUTPUT = (s: string): boolean => {
  const t = s.trim();
  return t === '' || t === '(no output)';
};

/** The card body as plain lines — arg block (a heredoc command)
 *  then every content entry flattened like dumpContent, minus the
 *  noise: `(no output)` results and blank lines are dropped, never
 *  a row. Capped for the under-call preview — `more` counts what
 *  the cap hid (the `+N more` row). */
export function toolBodyLines /* NOSONAR typescript:S3776 */(
  item: ToolItem,
  max = 3
): { lines: string[]; more: number } {
  const all: string[] = [];
  const arg = argBody(item);
  if (arg !== undefined) all.push(...arg.split('\n'));
  for (const c of item.content) {
    if (c.kind === 'text') {
      if (EMPTY_OUTPUT(c.text)) continue;
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
      if (EMPTY_OUTPUT(c.text)) continue;
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

/** Write to the system clipboard through a real clipboard tool when
 *  one exists. The OSC52 path has to survive the pane's pty → mux →
 *  outer terminal and any hop may silently drop it; clip.exe /
 *  wl-copy / xclip / pbcopy sidestep the whole chain. Best-effort:
 *  returns false when nothing usable is installed. */
export function sysCopy(text: string): boolean {
  const tryCmd = (bin: string, args: string[]): boolean => {
    try {
      // bounded: a wedged clip.exe (clipboard locked, headless env)
      // must never freeze the renderer — execFileSync blocks the
      // whole event loop while the child lives
      execFileSync(bin, args, {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 400,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform === 'darwin') return tryCmd('pbcopy', []);
  // WSL → the Windows clipboard
  try {
    if (readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase().includes('microsoft'))
      if (tryCmd('clip.exe', [])) return true;
  } catch {
    // not a /proc platform — keep probing
  }
  if (process.env.WAYLAND_DISPLAY !== undefined && tryCmd('wl-copy', [])) return true;
  if (process.env.DISPLAY !== undefined)
    return (
      tryCmd('xclip', ['-selection', 'clipboard']) || tryCmd('xsel', ['--clipboard', '--input'])
    );
  return false;
}
