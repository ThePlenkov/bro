/**
 * Frontmatter — a hand-rolled YAML-subset parser (the repo carries no
 * yaml dep). Supported: `key: scalar`, quoted strings, `key: [a, b]`
 * flow lists, `key: {a: 1}` flow maps, `key:` + indented `- item`
 * block lists, nested block maps (`fields:` schemas), `#` comments,
 * multi-line flow collections. Values coerce to string/number/
 * boolean/null/Array/Record — enough for every bro frontmatter shape.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  /** markdown body with the frontmatter block stripped */
  body: string;
  /** 0-based line where the body begins (0 when no frontmatter) */
  bodyOffset: number;
  /** 1-based source line of each top-level key — diagnostics point here */
  keyLines: Map<string, number>;
}

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    ? t.slice(1, -1)
    : t;
};

/** Can a scalar begin at index i? — after `[`, `{`, `,`, `:`, or at the
 *  fragment start (whitespace skipped). The `:` admits a quote opening
 *  a `key: "…"` value; a `'` mid-word (`it's`) still stays literal. */
const opensScalar = (t: string, i: number): boolean => {
  for (let k = i - 1; k >= 0; k--) {
    if (t[k] !== ' ' && t[k] !== '\t') {
      return t[k] === '[' || t[k] === '{' || t[k] === ',' || t[k] === ':';
    }
  }
  return true;
};

/** The index just past the close of quote `q`, scanning from `from`
 *  (`t[from]` is inside the scalar), or -1 when it never closes. `\\`
 *  escapes inside double quotes, `''` doubles inside single quotes. */
const quoteEnd = (t: string, q: string, from: number): number => {
  for (let i = from; i < t.length; i++) {
    if (q === '"' && t[i] === '\\') {
      i++;
    } else if (t[i] === q) {
      if (q === "'" && t[i + 1] === "'") {
        i++;
      } else {
        return i + 1;
      }
    }
  }
  return -1;
};

const closeQuote = (t: string, start: number): number => quoteEnd(t, t[start]!, start + 1);

/** The quote char `t` ends inside, or '' — a quoted scalar wrapped
 *  across lines continues on the next fragment. */
const openQuoteAtEnd = (t: string): string => {
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if ((ch === '"' || ch === "'") && opensScalar(t, i)) {
      const end = closeQuote(t, i);
      if (end === -1) {
        return ch;
      }
      i = end - 1;
    }
  }
  return '';
};

/** Index where a YAML comment begins — a `#` at the head or after a
 *  space/tab, outside quotes. -1 when the line is comment-free. */
const commentStart = (t: string): number => {
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if ((ch === '"' || ch === "'") && opensScalar(t, i)) {
      const end = closeQuote(t, i);
      if (end === -1) {
        return -1;
      }
      i = end - 1;
    } else if (ch === '#' && (i === 0 || t[i - 1] === ' ' || t[i - 1] === '\t')) {
      return i;
    }
  }
  return -1;
};

/** Strip a trailing ` #…` comment — quote-aware; `docs/it's.md # x`
 *  keeps its apostrophe and drops the note. */
const stripComment = (line: string): string => {
  const c = commentStart(line);
  return (c === -1 ? line : line.slice(0, c)).trimEnd();
};

/** Unescaped double-quoted content — `\\` and `\"` pairs collapse. */
const undouble = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
      i++;
    }
    out += s[i]!;
  }
  return out;
};

/** One scalar token → typed value. */
export const scalarValue = (s: string): unknown => {
  const t = s.trim();
  if (t === '') {
    return null;
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = closeQuote(t, 0);
    const tail = t.slice(end).trim();
    const v = end !== -1 && (tail === '' || tail.startsWith('#')) ? t.slice(0, end) : t;
    const u = unquote(v);
    if (v.startsWith('"')) {
      return undouble(u);
    }
    return v.startsWith("'") && v.endsWith("'") ? u.replaceAll("''", "'") : u;
  }
  const c = commentStart(t);
  const bare = (c === -1 ? t : t.slice(0, c)).trim();
  if (bare === 'true') {
    return true;
  }
  if (bare === 'false') {
    return false;
  }
  if (bare === 'null' || bare === '~' || bare === '') {
    return null;
  }
  if (/^-?\d+$/.test(bare)) {
    return Number.parseInt(bare, 10);
  }
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)$/.test(bare) || /^-?(\d+\.\d*|\.\d+)$/.test(bare)) {
    return Number.parseFloat(bare);
  }
  return bare;
};

/** Split a flow body on top-level commas — brackets and quotes nest. */
const flowSplit = (s: string): string[] => {
  const items: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ((ch === '"' || ch === "'") && opensScalar(s, i)) {
      const end = closeQuote(s, i);
      if (end !== -1) {
        cur += s.slice(i, end);
        i = end - 1;
        continue;
      }
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  items.push(cur);
  return items;
};

/** Index of the first `:` at flow depth 0, outside quotes — the
 *  key/value split inside a flow map entry. */
const flowColon = (s: string): number => {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ((ch === '"' || ch === "'") && opensScalar(s, i)) {
      const end = closeQuote(s, i);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ':' && depth === 0) {
      return i;
    }
  }
  return -1;
};

/** Net `[`/`{` depth at the end of `s` (outside quotes) plus the open
 *  quote char — 0 + '' means the flow collection is closed. */
const flowOpen = (s: string): { depth: number; quote: string } => {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ((ch === '"' || ch === "'") && opensScalar(s, i)) {
      const end = closeQuote(s, i);
      if (end === -1) {
        return { depth, quote: ch };
      }
      i = end - 1;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    }
  }
  return { depth, quote: '' };
};

/** Parse an inline value — flow collection or scalar. */
const inlineValue = (s: string): unknown => {
  const t = stripComment(s).trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    return flowSplit(t.slice(1, -1))
      .map(item => inlineValue(item))
      .filter(v => v !== null && v !== '');
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const out: Record<string, unknown> = {};
    for (const entry of flowSplit(t.slice(1, -1))) {
      const c = flowColon(entry);
      if (c === -1) {
        continue;
      }
      const key = String(scalarValue(entry.slice(0, c)));
      out[key] = inlineValue(entry.slice(c + 1));
    }
    return out;
  }
  return scalarValue(t);
};

interface Line {
  indent: number;
  text: string;
  /** 1-based source line within the frontmatter block */
  line: number;
}

const LIST_ITEM = /^-(\s+|$)/;
// A `key:` line — bare or quoted key, then a colon followed by
// whitespace/EOL (`http://x` is a scalar, not a key); `key:{…}` and
// `key:[…]` also open inline collections. The split is found with
// flowColon (first `:` outside quotes at depth 0) — no backtracking
// regex over untrusted text.
const KEY_SHAPE = /^(?:"[^"\n]*"|'[^'\n]*'|[^:'"\s][^:\n]*)$/;
const keyOf = (text: string): { key: string; rest: string } | undefined => {
  const c = flowColon(text);
  if (c === -1) {
    return undefined;
  }
  const rest = text.slice(c + 1);
  if (rest !== '' && !/^\s/.test(rest) && !/^\s*[[{]/.test(rest)) {
    return undefined;
  }
  const rawKey = text.slice(0, c).trim();
  if (rawKey === '' || !KEY_SHAPE.test(rawKey)) {
    return undefined;
  }
  return { key: String(scalarValue(rawKey)), rest };
};

/** Join a wrapped flow collection (`key: [` spread over lines) into one
 *  inline fragment — comment-stripped per line, quote-aware. */
const flowJoin = (inline: string, lines: Line[], i: number): { value: string; next: number } => {
  let joined = inline;
  let open = flowOpen(joined);
  let j = i;
  while ((open.depth > 0 || open.quote !== '') && j < lines.length) {
    const frag = lines[j]!.text;
    if (open.quote !== '') {
      const end = quoteEnd(frag, open.quote, 0);
      if (end === -1) {
        joined += ` ${frag}`;
        j++;
        continue;
      }
      const rest = frag.slice(end);
      const c = commentStart(rest);
      joined += ` ${(frag.slice(0, end) + (c === -1 ? rest : rest.slice(0, c))).trim()}`;
    } else {
      joined += ` ${frag}`;
    }
    open = flowOpen(joined);
    j++;
  }
  return { value: joined, next: j };
};

/** Map at indent `level` — consumes lines until indentation drops or a
 *  `- ` sibling list item ends it. Returns the map and next index. */
const parseMap = (lines: Line[], i: number, level: number): [Record<string, unknown>, number] => {
  const out: Record<string, unknown> = {};
  let cur = i;
  while (cur < lines.length) {
    const l = lines[cur]!;
    if (l.indent < level || (l.indent === level && LIST_ITEM.test(l.text))) {
      break;
    }
    const kv = keyOf(l.text);
    if (kv === undefined) {
      cur++;
      continue;
    }
    const inline = stripComment(kv.rest).trim();
    if (inline !== '') {
      const joined = flowJoin(inline, lines, cur + 1);
      out[kv.key] = inlineValue(joined.value);
      cur = joined.next;
      continue;
    }
    const next = lines[cur + 1];
    if (
      next === undefined ||
      next.indent < l.indent ||
      (next.indent === l.indent && !LIST_ITEM.test(next.text))
    ) {
      out[kv.key] = null;
      cur++;
      continue;
    }
    if (LIST_ITEM.test(next.text)) {
      // `- item` deeper than the key — or at its indent (YAML allows both).
      const [items, after] = parseList(lines, cur + 1, next.indent);
      out[kv.key] = items;
      cur = after;
    } else {
      const [map, after] = parseMap(lines, cur + 1, next.indent);
      out[kv.key] = map;
      cur = after;
    }
  }
  return [out, cur];
};

/** `- ` items at indent `level`. A `- key: v` item opens a map whose
 *  continuation lines sit deeper than the dash. */
const parseList = (lines: Line[], i: number, level: number): [unknown[], number] => {
  const out: unknown[] = [];
  let cur = i;
  while (cur < lines.length) {
    const l = lines[cur]!;
    if (l.indent !== level || !LIST_ITEM.test(l.text)) {
      break;
    }
    const text = l.text.replace(LIST_ITEM, '');
    const itemIndent = l.indent + (l.text.length - text.length);
    const kv = keyOf(text);
    if (kv !== undefined) {
      // `- key: v` — the dash item is a map; deeper lines continue it.
      // `after` indexes into [item, ...tail] where tail[k] = lines[cur+k].
      const item: Line = { indent: itemIndent, text, line: l.line };
      const [map, after] = parseMap([item, ...lines.slice(cur + 1)], 0, itemIndent);
      out.push(map);
      cur += after;
      continue;
    }
    out.push(inlineValue(text));
    cur++;
  }
  return [out, cur];
};

/** Parse the `---` block at the head of `content`. Absent or malformed
 *  frontmatter yields `{ data: {}, body: content }` — never throws. */
export function parseFrontmatter(content: string): Frontmatter {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  if (m === null) {
    return { data: {}, body: content, bodyOffset: 0, keyLines: new Map() };
  }
  const fmText = m[1]!;
  const body = content.slice(m[0].length);
  const bodyOffset = content.slice(0, m[0].length).split('\n').length - 1;
  const raw = fmText.split('\n');
  const lines: Line[] = [];
  for (const [idx, r] of raw.entries()) {
    const stripped = stripComment(r);
    if (stripped.trim() === '') {
      continue;
    }
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: stripped.trim(), line: idx + 1 });
  }
  const topIndent = lines[0]?.indent ?? 0;
  const keyLines = new Map<string, number>();
  for (const l of lines) {
    if (l.indent !== topIndent) {
      continue;
    }
    const kv = keyOf(l.text);
    if (kv !== undefined && !keyLines.has(kv.key)) {
      keyLines.set(kv.key, l.line);
    }
  }
  const [data] = lines.length === 0 ? [{}] : parseMap(lines, 0, topIndent);
  return { data, body, bodyOffset, keyLines };
}

// Structural chars force quoting anywhere; reserved openers (`-`, `@`,
// `&…`) only at position 0; plus empties, edge whitespace, words YAML
// would re-read as bool/null, and numeric-looking strings.
const NEEDS_QUOTE = /[:#\[\]{}"',]/;
const NEEDS_QUOTE_START = /^[-@`&*!|>%? \t]/;
const RESERVED = /^(true|false|null|~)$/i;
const NUMERIC = /^-?[\d.]+$/;

const scalarOut = (v: unknown): string => {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  const s = String(v);
  if (
    s === '' ||
    NEEDS_QUOTE.test(s) ||
    NEEDS_QUOTE_START.test(s) ||
    /\s$/.test(s) ||
    RESERVED.test(s) ||
    NUMERIC.test(s)
  ) {
    return `'${s.replaceAll("'", "''")}'`;
  }
  return s;
};

const dumpLines = (obj: Record<string, unknown>, indent: string): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key =
      NEEDS_QUOTE.test(k) || NEEDS_QUOTE_START.test(k) || /\s$/.test(k) ? scalarOut(k) : k;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${indent}${key}: []`);
        continue;
      }
      out.push(`${indent}${key}:`);
      for (const item of v) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const entries = dumpLines(item as Record<string, unknown>, `${indent}    `);
          const first = entries[0];
          if (first === undefined) {
            out.push(`${indent}  - {}`);
          } else {
            out.push(`${indent}  - ${first.trimStart()}`);
            out.push(...entries.slice(1));
          }
        } else {
          out.push(`${indent}  - ${scalarOut(item)}`);
        }
      }
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        out.push(`${indent}${key}: {}`);
        continue;
      }
      out.push(`${indent}${key}:`);
      out.push(...dumpLines(v as Record<string, unknown>, `${indent}  `));
    } else {
      out.push(`${indent}${key}: ${scalarOut(v)}`);
    }
  }
  return out;
};

/** Serialize a frontmatter record to the YAML subset — the inverse of
 *  `parseFrontmatter` for the values `create` emits. */
export function dumpFrontmatter(data: Record<string, unknown>): string {
  return `${dumpLines(data, '').join('\n')}\n`;
}
