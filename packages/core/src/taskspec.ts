/**
 * TaskSpec — the pipeline item AS spec (spec specs/bro-7d5nb.md
 * §task spec facade, epic bro-qjji2). Pipeline stages read an item's
 * DoR/DoD/acceptance-criteria/test-scenarios through this semantic
 * facade, never through the store's native row API — `description`
 * is the carrier, TaskSpec is the contract. bd is the first adapter
 * (`taskSpecFacade(taskStore(dir))`); a different task store
 * implements the same facade — or binds this one when its items
 * carry the same convention — never a second parser in a consumer.
 *
 * The carrier convention: the item's markdown body holds the spec
 * under `## Acceptance`, `## DoD`, `## DoR`, `## Scenarios` headings
 * (level-2 ATX — up to 3 leading spaces like CommonMark; names match
 * case-insensitively; the first occurrence wins — a repeated heading
 * and its text are body prose, not a second section). Bullet items
 * under Acceptance/Scenarios become `acceptance[]`/`scenarios[]` —
 * `-`/`*`/`+`/`•` and numbered items all count, and a section mixing
 * bullets with prose keeps the bullets; a bullet-less section's
 * non-empty lines are the items. `## DoD`/`## DoR` text lands
 * verbatim in `dod`/`dor`. Everything outside the managed sections —
 * prose, other headings, `###` subsections — is `body`. Fenced code
 * blocks (``` and ~~~) are opaque: a `## Acceptance` inside a fence
 * is an example, not a section, and a `- example` inside one is never
 * an item. `acceptance` absent-or-empty is verify's `unverifiable`
 * input, never "no checks".
 *
 * The same seam is the write path for intake artifacts: `annotate`
 * appends `## <heading>` + lines to the body so `questions` and
 * `declined` feedback land ON the item and the next intake pass
 * reads the enriched spec. Artifact lines are verbatim text — a
 * segment that would open structure (an ATX heading, a code fence)
 * throws, because a heading in an artifact truncates its section on
 * the next read and an unclosed fence hides every artifact after it.
 * The append is read-modify-write through `store.update({description})`
 * — best-effort like every store patch: two annotates racing one
 * item interleave, they don't transact. A `<!-- bro: -->` metadata
 * trailer keeps its body-last position across the append
 * (taskmeta.ts's contract).
 *
 * The parser is deliberately regex-free on the line path — heading,
 * fence, and bullet probes are linear string scans, so a hostile
 * body can't wedge the event loop (CodeQL polynomial-regex).
 */
import { bodyMeta, stripMeta, withMeta } from './taskmeta.ts';
import type { TaskRow, TaskStore } from './tasks.ts';

/** The item's spec — the semantic projection of its body. `id`/`title`
 *  mirror the store row; the rest is parsed out of the markdown. */
export interface TaskSpec {
  id: string;
  title: string;
  /** description/context — the body minus the managed spec sections;
   *  absent when nothing else remains. */
  body?: string;
  /** AC rows — verify's input. Absent-or-empty is `unverifiable`. */
  acceptance?: string[];
  /** definition-of-done — the `## DoD` section's text, verbatim. */
  dod?: string;
  /** definition-of-ready — the `## DoR` section's text, verbatim. */
  dor?: string;
  /** test scenarios — the `## Scenarios` section's items. */
  scenarios?: string[];
}

/** The read/write seam the pipeline consumes — tests fake it, prod
 *  binds {@link taskSpecFacade} over the configured TaskStore. */
export interface TaskSpecFacade {
  /** `taskSpec(id)` — the item's spec projection, or undefined when
   *  the store has no such item (same miss semantics as `get`). */
  spec(id: string): TaskSpec | undefined;
  /** `taskAnnotate(id, heading, lines)` — an intake artifact lands
   *  ON the item as `## <heading>` + the lines. Fails loud: a missing
   *  item, an empty or multi-line heading, an empty artifact, a
   *  managed section name that already exists, and a line whose
   *  segments open structure (an ATX heading or code fence — an
   *  artifact's text never becomes a section) all throw. */
  annotate(id: string, heading: string, lines: readonly string[]): void;
}

type SpecField = 'acceptance' | 'dod' | 'dor' | 'scenarios';

/** The projection half of TaskSpec — what the body carries. */
type SpecFields = Pick<TaskSpec, 'body' | 'acceptance' | 'dod' | 'dor' | 'scenarios'>;

/** Managed heading name (lowercased) → the field its section feeds.
 *  Lookups are own-key gated — see {@link managedField}. */
const MANAGED: Record<string, SpecField> = {
  acceptance: 'acceptance',
  dod: 'dod',
  dor: 'dor',
  scenarios: 'scenarios',
};

/** A body line with its fenced-ness — lines inside a code fence are
 *  literal text: no headings start, no bullets count. */
interface Line {
  t: string;
  fenced: boolean;
}

/** A parsed ATX heading — its level plus the name minus decoration. */
interface Heading {
  level: number;
  name: string;
}

/** space/tab — CommonMark's heading and list whitespace. */
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** The bullet marks that open an item line (`-`, `*`, `+`, `•`). */
const BULLETS = new Set(['-', '*', '+', '•']);

const isBulletMark = (c: string | undefined): boolean => c !== undefined && BULLETS.has(c);

/** Consecutive `ch` run length from index i — the one scan shape the
 *  parser's probes all share (spaces, `#`s, fence chars, digits are
 *  all runs). */
function charRun(raw: string, i: number, ch: string): number {
  let n = 0;
  while (raw[i + n] === ch) n++;
  return n;
}

/** Leading-space count — CommonMark's ≤3 indent rule uses it. */
function leadingSpaces(raw: string): number {
  return charRun(raw, 0, ' ');
}

/** Where a trailing `#` run starts, when it is a real closing
 *  sequence — all-`#` text or a run preceded by whitespace. */
function closingRunStart(t: string): number | undefined {
  let e = t.length;
  while (e > 0 && t[e - 1] === '#') e--;
  const bounded = e === 0 || isBlank(t[e - 1]);
  return e < t.length && bounded ? e : undefined;
}

/** Heading text → its name — the ATX closing sequence (a trailing
 *  `#` run preceded by whitespace) is decoration, not name. */
function headingName(text: string): string {
  const t = text.trim();
  const e = closingRunStart(t);
  return e === undefined ? t : t.slice(0, e).trimEnd();
}

/** CommonMark heading legality — 1–6 `#`s, then a space/tab/EOL
 *  before the name (`##Acceptance` — no space — is prose). */
function legalHeading(raw: string, i: number, level: number): boolean {
  if (level === 0 || level > 6) return false;
  const next = raw[i + level];
  return next === undefined || isBlank(next);
}

/** ATX heading probe — a linear string scan, never a regex on
 *  uncontrolled data. Up to 3 leading spaces (4+ is indented code),
 *  then the legalHeading shape. Every level answers — `###`+
 *  headings terminate managed sections like `##` ones do. */
function headingOf(raw: string): Heading | null {
  const i = leadingSpaces(raw);
  if (i > 3) return null;
  const level = charRun(raw, i, '#');
  if (!legalHeading(raw, i, level)) return null;
  return { level, name: headingName(raw.slice(i + level)) };
}

interface FenceMark {
  ch: string;
  len: number;
  info: string;
}

/** 3+ of one fence char after the indent → the mark, else null.
 *  ` ``` ` and `~~~` are the only chars. */
function fenceMark(raw: string, i: number): { ch: string; len: number } | null {
  const ch = raw[i];
  if (ch !== '`' && ch !== '~') return null;
  const len = charRun(raw, i, ch);
  return len >= 3 ? { ch, len } : null;
}

/** Fenced-code marker probe — ` ``` ` or `~~~`, ≤3 leading spaces;
 *  `info` is the tag after the marker (` ```ts `). A backtick marker
 *  whose info contains '`' is an inline-code line, never a fence.
 *  Closers need `info === ''` — an info string on a `~~~` line
 *  inside a fence is content. */
function fenceOf(raw: string): FenceMark | null {
  const i = leadingSpaces(raw);
  if (i > 3) return null;
  const mark = fenceMark(raw, i);
  if (mark === null) return null;
  const info = raw.slice(i + mark.len).trim();
  if (mark.ch === '`' && info.includes('`')) return null;
  return { ...mark, info };
}

/** `N.`/`N)` followed by a blank → the item text, else null. ≤9
 *  digits per CommonMark. */
function numberedText(t: string): string | null {
  let i = 0;
  while (isDigit(t[i])) i++;
  if (i > 9) return null;
  const dot = t[i] === '.' || t[i] === ')';
  return dot && isBlank(t[i + 1]) ? t.slice(i + 1).trim() : null;
}

/** Bullet item text — `-`/`*`/`+`/`•` or `N.`/`N)` numbered — or
 *  null when the line isn't an item. Linear string scan, same
 *  contract as headingOf/fenceOf. */
function bulletText(raw: string): string | null {
  const t = raw.trimStart();
  if (isBulletMark(t[0])) {
    return isBlank(t[1]) ? t.slice(1).trim() : null;
  }
  return isDigit(t[0]) ? numberedText(t) : null;
}

/** Non-null and non-empty — the bullet filter's guard. */
const isItemText = (s: string | null): s is string => s !== null && s !== '';

/** Bullet items when the live (unfenced) lines have any, else the
 *  non-empty ones — an AC written as a bare sentence is still a
 *  criterion, but intro prose next to real bullets is not. */
function itemsOf(lines: Line[]): string[] {
  const live = lines.filter(l => !l.fenced).map(l => l.t);
  const bullets = live.map(bulletText).filter(isItemText);
  return bullets.length > 0 ? bullets : live.map(l => l.trim()).filter(s => s !== '');
}

/** The section's text verbatim — undefined for an absent/empty one.
 *  Fenced content stays: a ``` block inside `## DoD` is content. */
function textOf(lines: Line[] | undefined): string | undefined {
  const t =
    lines
      ?.map(l => l.t)
      .join('\n')
      .trim() ?? '';
  return t === '' ? undefined : t;
}

interface ParsedBody {
  fields: SpecFields;
  /** managed sections seen — even empty ones; annotate's dup guard
   *  needs presence, not parsed content. */
  present: Set<SpecField>;
}

/** One parseBody pass's mutable state — the section sinks plus the
 *  fence marker currently open (null outside a fence). */
interface ParseState {
  bodyLines: Line[];
  /** the sink the next line lands in — bodyLines or a section's. */
  cur: Line[];
  present: Set<SpecField>;
  content: Map<SpecField, Line[]>;
  fence: FenceMark | null;
}

/** Heading → the managed field it opens. Own-key gated: a prototype
 *  member (`## Constructor`, `## __proto__`, `## ToString`) resolves
 *  to an Object.prototype member, and an ungated lookup would open a
 *  "managed" section that silently eats the heading's text into a
 *  field that never existed. Non-level-2 headings never manage. */
function managedField(h: Heading): SpecField | undefined {
  if (h.level !== 2) return undefined;
  const name = h.name.toLowerCase();
  return Object.hasOwn(MANAGED, name) ? MANAGED[name] : undefined;
}

/** A heading line — starts its managed section on first sighting and
 *  retargets the line sink at it; anything else (an unmanaged name,
 *  a duplicate, a non-level-2 heading) stays body prose. */
function openSection(h: Heading, raw: string, st: ParseState): void {
  const field = managedField(h);
  if (field === undefined || st.present.has(field)) {
    st.bodyLines.push({ t: raw, fenced: false });
    st.cur = st.bodyLines;
    return;
  }
  st.present.add(field);
  const lines: Line[] = [];
  st.content.set(field, lines);
  st.cur = lines;
}

/** A fence closer: same char, run length ≥ the opener's, bare info
 *  (` ``` ` closes ` ```ts `, ` ```ts ` never does). */
function closesOn(f: FenceMark, open: FenceMark): boolean {
  if (f.ch !== open.ch || f.info !== '') return false;
  return f.len >= open.len;
}

/** A line inside an open fence — literal text; only its closer
 *  reopens the live stream. */
function fencedLine(raw: string, f: FenceMark | null, open: FenceMark, st: ParseState): void {
  st.cur.push({ t: raw, fenced: true });
  if (f !== null && closesOn(f, open)) st.fence = null;
}

/** The line that opens a fence — it is itself fenced content. */
function openFence(raw: string, f: FenceMark, st: ParseState): void {
  st.fence = f;
  st.cur.push({ t: raw, fenced: true });
}

/** A live (unfenced) line — either section content or the heading
 *  that retargets the sink. */
function liveLine(raw: string, st: ParseState): void {
  const h = headingOf(raw);
  if (h === null) {
    st.cur.push({ t: raw, fenced: false });
    return;
  }
  openSection(h, raw, st);
}

/** One body line through the fence/heading state machine — fence
 *  state runs ahead of heading detection: inside ```/~~~ no heading
 *  opens and no bullet counts. */
function feedLine(raw: string, st: ParseState): void {
  const f = fenceOf(raw);
  if (st.fence !== null) {
    fencedLine(raw, f, st.fence, st);
    return;
  }
  if (f !== null) {
    openFence(raw, f, st);
    return;
  }
  liveLine(raw, st);
}

/** Item sections — bullets when present, non-empty lines else. */
function putItems(
  fields: SpecFields,
  k: 'acceptance' | 'scenarios',
  lines: Line[] | undefined
): void {
  const items = itemsOf(lines ?? []);
  if (items.length > 0) fields[k] = items;
}

/** Text sections — verbatim, absent when empty. */
function putText(fields: SpecFields, k: 'dod' | 'dor', lines: Line[] | undefined): void {
  const t = textOf(lines);
  if (t !== undefined) fields[k] = t;
}

/** Collected lines → the spec fields — body verbatim, item sections
 *  bullet-extracted, text sections verbatim. */
function fieldsOf(content: Map<SpecField, Line[]>, bodyLines: Line[]): SpecFields {
  const fields: SpecFields = {};
  const body = textOf(bodyLines);
  if (body !== undefined) fields.body = body;
  putItems(fields, 'acceptance', content.get('acceptance'));
  putItems(fields, 'scenarios', content.get('scenarios'));
  putText(fields, 'dod', content.get('dod'));
  putText(fields, 'dor', content.get('dor'));
  return fields;
}

/** One pass over the body — managed sections out, the rest is body. */
function parseBody(description: string): ParsedBody {
  const bodyLines: Line[] = [];
  const st: ParseState = {
    bodyLines,
    cur: bodyLines,
    present: new Set(),
    content: new Map(),
    fence: null,
  };
  for (const raw of description.split(/\r?\n/)) {
    feedLine(raw, st);
  }
  return { fields: fieldsOf(st.content, st.bodyLines), present: st.present };
}

/** The body's spec fields — the pure parser every TaskSpec adapter
 *  shares (the section convention is backend-neutral markdown; the
 *  `<!-- bro: -->` trailer is stripped before sectioning). Exported
 *  so a store with a native spec surface can still reuse it on a
 *  markdown arm, and so tests drive the parser without a store. */
export function parseTaskSpecBody(description: string | undefined): SpecFields {
  return parseBody(stripMeta(description)).fields;
}

/** Row → spec — `description` is the whole input; a row without one
 *  projects to `{id, title}` (the `unverifiable` shape). */
function specFromRow(row: TaskRow): TaskSpec {
  return { id: row.id, title: row.title ?? '', ...parseTaskSpecBody(row.description) };
}

/** One artifact element's segments must all be verbatim prose — an
 *  ATX heading truncates its section on the next read (a managed
 *  name would inject spec fields); a fence marker hides every later
 *  artifact inside it. Both fail loud. */
function checkVerbatim(line: string): void {
  for (const seg of line.split(/\r?\n/)) {
    if (headingOf(seg) !== null || fenceOf(seg) !== null) {
      throw new Error(
        `taskSpec annotate: artifact line ${JSON.stringify(seg)} opens structure — ` +
          'artifact text never becomes a section or a fence'
      );
    }
  }
}

/** annotate's input contract — the heading is a single line and
 *  every line is verbatim text, never structure. */
function checkAnnotateInput(heading: string, lines: readonly string[]): string {
  const h = heading.trim();
  if (h === '' || /[\r\n]/.test(h)) {
    throw new Error('taskSpec annotate: heading must be a single non-empty line');
  }
  if (lines.length === 0) {
    throw new Error('taskSpec annotate: an artifact with no lines is no artifact');
  }
  for (const line of lines) {
    checkVerbatim(line);
  }
  return h;
}

/** The dup guard — same normalization the parser applies, so
 *  'Acceptance ##' names the managed section; a miss would write
 *  dead text the spec read never reaches (first wins). */
function guardDuplicate(row: TaskRow, h: string, id: string): void {
  const managed = managedField({ level: 2, name: headingName(h) });
  const dup = managed !== undefined && parseBody(stripMeta(row.description)).present.has(managed);
  if (dup) {
    throw new Error(
      `taskSpec annotate: "## ${h}" already exists on ${id} — ` +
        'a duplicate never reaches the spec read (first wins)'
    );
  }
}

/** The append — blank-separated onto the (meta-stripped) body; the
 *  `<!-- bro: -->` trailer goes back last (taskmeta's contract). */
function appendSection(row: TaskRow, section: string): string {
  const base = stripMeta(row.description);
  const body = base === '' ? section : `${base}\n\n${section}`;
  return withMeta(body, bodyMeta(row.description));
}

/**
 * The prod adapter — the TaskSpecFacade over a TaskStore. bd is the
 * first store it binds (`taskSpecFacade(taskStore(dir))`); any
 * backend whose rows carry the markdown convention works the same —
 * a store whose spec lives elsewhere implements TaskSpecFacade
 * natively instead. The port is the contract, this is its first
 * adapter.
 */
export function taskSpecFacade(store: TaskStore): TaskSpecFacade {
  return {
    spec: id => {
      const row = store.get(id);
      return row === undefined ? undefined : specFromRow(row);
    },
    annotate: (id, heading, lines) => {
      const h = checkAnnotateInput(heading, lines);
      const row = store.get(id);
      if (row === undefined) {
        throw new Error(`taskSpec annotate: item "${id}" is not in the store`);
      }
      guardDuplicate(row, h, id);
      store.update(id, { description: appendSection(row, `## ${h}\n${lines.join('\n')}`) });
    },
  };
}
