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
 *  Every index into it is own-key gated (`Object.hasOwn`): a
 *  prototype member (`## Constructor`, `## __proto__`, `## ToString`)
 *  resolves to an Object.prototype member, and an ungated lookup
 *  would open a "managed" section that silently eats the heading's
 *  text into a field that never existed. */
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

/** Heading text → its name — the ATX closing sequence (a trailing
 *  `#` run preceded by whitespace) is decoration, not name. */
function headingName(text: string): string {
  const t = text.trim();
  let e = t.length;
  while (e > 0 && t[e - 1] === '#') e--;
  if (e < t.length && (e === 0 || t[e - 1] === ' ' || t[e - 1] === '\t')) {
    return t.slice(0, e).trimEnd();
  }
  return t;
}

/** ATX heading probe — a linear string scan, never a regex on
 *  uncontrolled data. CommonMark shape: up to 3 leading spaces
 *  (4+ is indented code), 1–6 `#`s, then a space/tab/EOL, then the
 *  name minus its closing run. Every level answers — `###`+ headings
 *  terminate managed sections like `##` ones do. */
function headingOf(raw: string): { level: number; name: string } | null {
  let i = 0;
  while (raw[i] === ' ') i++;
  if (i > 3) {
    return null;
  }
  let level = 0;
  while (raw[i + level] === '#') level++;
  if (level === 0 || level > 6) {
    return null;
  }
  const next = raw[i + level];
  if (next !== undefined && next !== ' ' && next !== '\t') {
    return null; // `##Acceptance` — no space — is prose, not a heading
  }
  return { level, name: headingName(raw.slice(i + level)) };
}

interface FenceMark {
  ch: string;
  len: number;
  info: string;
}

/** Fenced-code marker probe — ` ``` ` or `~~~` (3+ of one char), ≤3
 *  leading spaces; `info` is the tag after the marker (` ```ts `).
 *  A backtick marker whose info contains '`' is an inline-code line,
 *  never a fence. Closers need `info === ''` — an info string on a
 *  `~~~` line inside a fence is content. */
function fenceOf(raw: string): FenceMark | null {
  let i = 0;
  while (raw[i] === ' ') i++;
  if (i > 3) {
    return null;
  }
  const ch = raw[i];
  if (ch !== '`' && ch !== '~') {
    return null;
  }
  let len = 0;
  while (raw[i + len] === ch) len++;
  if (len < 3) {
    return null;
  }
  const info = raw.slice(i + len).trim();
  return ch === '`' && info.includes('`') ? null : { ch, len, info };
}

/** Bullet item text — `-`/`*`/`+`/`•` or `N.`/`N)` numbered (≤9
 *  digits per CommonMark) — or null when the line isn't an item.
 *  Linear string scan, same contract as headingOf/fenceOf. */
function bulletText(raw: string): string | null {
  const t = raw.trimStart();
  const c = t[0];
  if (c === '-' || c === '*' || c === '+' || c === '•') {
    return t[1] === ' ' || t[1] === '\t' ? t.slice(1).trim() : null;
  }
  if (c !== undefined && c >= '0' && c <= '9') {
    let i = 0;
    while (t[i] !== undefined && t[i] >= '0' && t[i] <= '9') i++;
    if (i <= 9 && (t[i] === '.' || t[i] === ')') && (t[i + 1] === ' ' || t[i + 1] === '\t')) {
      return t.slice(i + 1).trim();
    }
  }
  return null;
}

/** Bullet items when the live (unfenced) lines have any, else the
 *  non-empty ones — an AC written as a bare sentence is still a
 *  criterion, but intro prose next to real bullets is not. */
function itemsOf(lines: Line[]): string[] {
  const live = lines.filter(l => !l.fenced).map(l => l.t);
  const bullets = live.map(bulletText).filter((s): s is string => s !== null && s !== '');
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

/** A heading line — starts its managed section on first sighting and
 *  answers that section's line sink; anything else (an unmanaged
 *  name, a duplicate, a non-level-2 heading) is body prose. */
function openSection(
  h: { level: number; name: string },
  raw: string,
  present: Set<SpecField>,
  content: Map<SpecField, Line[]>,
  bodyLines: Line[]
): Line[] {
  const name = h.name.toLowerCase();
  const field = h.level === 2 && Object.hasOwn(MANAGED, name) ? MANAGED[name] : undefined;
  if (field === undefined || present.has(field)) {
    bodyLines.push({ t: raw, fenced: false });
    return bodyLines;
  }
  present.add(field);
  const lines: Line[] = [];
  content.set(field, lines);
  return lines;
}

/** Collected lines → the spec fields — body verbatim, item sections
 *  bullet-extracted, text sections verbatim. */
function fieldsOf(content: Map<SpecField, Line[]>, bodyLines: Line[]): SpecFields {
  const fields: SpecFields = {};
  const body = bodyLines
    .map(l => l.t)
    .join('\n')
    .trim();
  if (body !== '') {
    fields.body = body;
  }
  const acceptance = itemsOf(content.get('acceptance') ?? []);
  if (acceptance.length > 0) {
    fields.acceptance = acceptance;
  }
  const scenarios = itemsOf(content.get('scenarios') ?? []);
  if (scenarios.length > 0) {
    fields.scenarios = scenarios;
  }
  const dod = textOf(content.get('dod'));
  if (dod !== undefined) {
    fields.dod = dod;
  }
  const dor = textOf(content.get('dor'));
  if (dor !== undefined) {
    fields.dor = dor;
  }
  return fields;
}

/** One pass over the body — managed sections out, the rest is body.
 *  Fence state runs ahead of heading detection: inside ```/~~~ no
 *  heading opens and no bullet counts. */
function parseBody(description: string): ParsedBody {
  const bodyLines: Line[] = [];
  const present = new Set<SpecField>();
  const content = new Map<SpecField, Line[]>();
  let curLines = bodyLines;
  let fence: FenceMark | null = null;
  for (const raw of description.split(/\r?\n/)) {
    const f = fenceOf(raw);
    if (fence !== null) {
      curLines.push({ t: raw, fenced: true });
      if (f !== null && f.ch === fence.ch && f.len >= fence.len && f.info === '') {
        fence = null;
      }
      continue;
    }
    if (f !== null) {
      fence = f;
      curLines.push({ t: raw, fenced: true });
      continue;
    }
    const h = headingOf(raw);
    if (h === null) {
      curLines.push({ t: raw, fenced: false });
    } else {
      curLines = openSection(h, raw, present, content, bodyLines);
    }
  }
  return { fields: fieldsOf(content, bodyLines), present };
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

/** annotate's input contract — the heading is a single line and
 *  every line segment is verbatim text, never structure. An ATX
 *  heading in an artifact truncates its section on the next read
 *  (a managed name would inject spec fields); a fence marker hides
 *  every later artifact inside it. Both fail loud. */
function checkAnnotateInput(heading: string, lines: readonly string[]): string {
  const h = heading.trim();
  if (h === '' || /[\r\n]/.test(h)) {
    throw new Error('taskSpec annotate: heading must be a single non-empty line');
  }
  if (lines.length === 0) {
    throw new Error('taskSpec annotate: an artifact with no lines is no artifact');
  }
  for (const line of lines) {
    for (const seg of line.split(/\r?\n/)) {
      if (headingOf(seg) !== null || fenceOf(seg) !== null) {
        throw new Error(
          `taskSpec annotate: artifact line ${JSON.stringify(seg)} opens structure — ` +
            'artifact text never becomes a section or a fence'
        );
      }
    }
  }
  return h;
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
      // same normalization the parser applies — 'Acceptance ##' names
      // the managed section, a miss would write dead text
      const mname = headingName(h).toLowerCase();
      const managed = Object.hasOwn(MANAGED, mname) ? MANAGED[mname] : undefined;
      if (managed !== undefined && parseBody(stripMeta(row.description)).present.has(managed)) {
        throw new Error(
          `taskSpec annotate: "## ${h}" already exists on ${id} — ` +
            'a duplicate never reaches the spec read (first wins)'
        );
      }
      const base = stripMeta(row.description);
      const section = `## ${h}\n${lines.join('\n')}`;
      const body = base === '' ? section : `${base}\n\n${section}`;
      store.update(id, { description: withMeta(body, bodyMeta(row.description)) });
    },
  };
}
