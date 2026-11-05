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
 * (level-2 ATX; names match case-insensitively; the first occurrence
 * wins — a repeated heading and its text are body prose, not a
 * second section). Bullet items under Acceptance/Scenarios become
 * `acceptance[]`/`scenarios[]` — `-`/`*`/`+`/`•` and numbered items
 * all count, and a section mixing bullets with prose keeps the
 * bullets; a bullet-less section's non-empty lines are the items.
 * `## DoD`/`## DoR` text lands verbatim in `dod`/`dor`. Everything
 * outside the managed sections — prose, other headings, a `###`
 * subsection — is `body`. `acceptance` absent-or-empty is verify's
 * `unverifiable` input, never "no checks".
 *
 * The same seam is the write path for intake artifacts: `annotate`
 * appends `## <heading>` + lines to the body so `questions` and
 * `declined` feedback land ON the item and the next intake pass
 * reads the enriched spec. The append is read-modify-write through
 * `store.update({description})` — best-effort like every store
 * patch: two annotates racing one item interleave, they don't
 * transact. A `<!-- bro: -->` metadata trailer keeps its body-last
 * position across the append (taskmeta.ts's contract).
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
   *  item, an empty or multi-line heading, an empty artifact, and a
   *  managed section name that already exists all throw — a second
   *  `## Acceptance` never reaches the parser's first-wins read, so
   *  writing one would be a silent no-op. */
  annotate(id: string, heading: string, lines: readonly string[]): void;
}

type SpecField = 'acceptance' | 'dod' | 'dor' | 'scenarios';

/** The projection half of TaskSpec — what the body carries. */
type SpecFields = Pick<TaskSpec, 'body' | 'acceptance' | 'dod' | 'dor' | 'scenarios'>;

/** Managed heading name (lowercased) → the field its section feeds. */
const MANAGED: Record<string, SpecField> = {
  acceptance: 'acceptance',
  dod: 'dod',
  dor: 'dor',
  scenarios: 'scenarios',
};

/** ATX heading — `##Acceptance` (no space) is prose, not a heading. */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** `## Foo ##` — the ATX closing sequence is decoration, not name. */
const CLOSING_HASHES = /\s+#+\s*$/;
/** A list item — `-`, `*`, `+`, `•`, or `1.`/`1)` numbered. */
const BULLET = /^\s*(?:[-*+•]|\d{1,9}[.)])\s+(.+)$/;

interface ParsedBody {
  fields: SpecFields;
  /** managed sections seen — even empty ones; annotate's dup guard
   *  needs presence, not parsed content. */
  present: Set<SpecField>;
}

/** Bullet items when the section has any, else its non-empty lines —
 *  an AC written as a bare sentence is still a criterion, but intro
 *  prose next to real bullets is not. */
function itemsOf(lines: string[]): string[] {
  const bullets = lines
    .map(l => BULLET.exec(l)?.[1]?.trim())
    .filter((s): s is string => s !== undefined && s !== '');
  return bullets.length > 0 ? bullets : lines.map(l => l.trim()).filter(s => s !== '');
}

/** The section's text verbatim — undefined for an absent/empty one. */
function textOf(lines: string[] | undefined): string | undefined {
  const t = lines?.join('\n').trim() ?? '';
  return t === '' ? undefined : t;
}

/** One pass over the body — managed sections out, the rest is body. */
function parseBody(description: string): ParsedBody {
  const bodyLines: string[] = [];
  const present = new Set<SpecField>();
  const content = new Map<SpecField, string[]>();
  // curLines collects into the current sink — body or a section's array
  let curLines = bodyLines;
  for (const raw of description.split(/\r?\n/)) {
    const h = HEADING.exec(raw);
    if (h === null || h[1]!.length > 2) {
      // a content line, or a ### subheading inside the section
      curLines.push(raw);
      continue;
    }
    const name = h[2]!.replace(CLOSING_HASHES, '').trim().toLowerCase();
    const field = h[1]!.length === 2 ? MANAGED[name] : undefined;
    if (field === undefined || present.has(field)) {
      // an unmanaged or duplicate heading — body prose like any other
      curLines = bodyLines;
      bodyLines.push(raw);
    } else {
      present.add(field);
      curLines = [];
      content.set(field, curLines);
    }
  }
  const fields: SpecFields = {};
  const body = bodyLines.join('\n').trim();
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
  return { fields, present };
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
      const h = heading.trim();
      if (h === '' || /[\r\n]/.test(h)) {
        throw new Error('taskSpec annotate: heading must be a single non-empty line');
      }
      if (lines.length === 0) {
        throw new Error('taskSpec annotate: an artifact with no lines is no artifact');
      }
      const row = store.get(id);
      if (row === undefined) {
        throw new Error(`taskSpec annotate: item "${id}" is not in the store`);
      }
      const parsed = parseBody(stripMeta(row.description));
      const managed = MANAGED[h.toLowerCase()];
      if (managed !== undefined && parsed.present.has(managed)) {
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
