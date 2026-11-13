/**
 * The dry-run diff — what the write WOULD change.
 *
 * The operator's settings file is theirs: the write is opt-in, and the
 * dry-run shows the change before anything lands. The diff is a diff of
 * the SETTINGS OBJECT (that is what the file holds), key by key: the
 * key the client owns is replaced, every other key is untouched, and
 * the operator reads both facts before the file is touched at all.
 *
 * The diff says what changed, not how many bytes moved: a block of 547
 * model rows is one line in this diff, and the block itself is still
 * printed on its own. What the one line cannot say is WHICH rows the
 * write takes — the block is regenerated, not accumulated, so a curated
 * row the router no longer serves disappears silently. The diff names
 * those rows: `dropped` carries them, and the formatter prints them
 * under the change, so the operator reads which curated entries the
 * write would remove before it lands.
 */

/** One key's change. */
export interface SettingsChange {
  /** the settings key */
  key: string;
  /** what happened to the key */
  kind: 'added' | 'removed' | 'changed';
  /** what changed, in the operator's words */
  detail: string;
  /** the rows the change drops — the curated entries the write takes,
   *  named (present only when the key holds a row block and rows drop) */
  dropped?: string[];
}

/** The rows of a model block — the block's own `options` shape. */
function blockRows(value: unknown): unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const options = (value as { options?: unknown }).options;
  return Array.isArray(options) ? options : undefined;
}

/** The rows of a model block — the block's own shape. */
function rowCount(value: unknown): number | undefined {
  const rows = blockRows(value);
  return rows === undefined ? undefined : rows.length;
}

/** One row's name — what the operator reads it by. A row is named by its
 *  own id field (`model`, then `id`, then `name`), by itself when it is a
 *  scalar, and by its JSON when it is neither: a row the diff cannot name
 *  is a row the operator cannot check. The name is the row's IDENTITY —
 *  a row the write still serves keeps its place even when the write
 *  refreshes its label or handling; only a name gone from the new block
 *  is a dropped row. */
function rowName(row: unknown): string {
  if (typeof row === 'object' && row !== null) {
    const record = row as Record<string, unknown>;
    for (const key of ['model', 'id', 'name']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return JSON.stringify(row);
  }
  return String(row);
}

/** The names of the rows `before` carries that `after` does not — the
 *  curated entries the write takes with it, in the file's own order.
 *  Undefined when the before-value holds no row block or nothing drops:
 *  `dropped` absent means the change removes no rows, and an empty list
 *  would say the same thing louder. */
function droppedRows(before: unknown, after: unknown): string[] | undefined {
  const was = blockRows(before);
  if (was === undefined) return undefined;
  const now = new Set((blockRows(after) ?? []).map(rowName));
  const dropped = [...new Set(was.map(rowName).filter(name => !now.has(name)))];
  return dropped.length === 0 ? undefined : dropped;
}

/** One value, said in a few words. */
function summarize(value: unknown): string {
  const rows = rowCount(value);
  if (rows !== undefined) return `${rows} model row(s)`;
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return scalarSummary(value);
}

/** The scalars, said in a few words — the object is named BEFORE any
 *  stringifier sees it, so nothing ever prints "[object Object]". */
function scalarSummary(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return `"${value}"`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return value === null ? 'null' : 'an object';
    default:
      return 'a value';
  }
}

/** One key's change — undefined when the key did not change. */
function changeOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string
): SettingsChange | undefined {
  // the value is read ONCE, into a name of its own: the key is one of the
  // object's own keys (Object.keys never reaches a prototype), and the
  // diff speaks about the VALUE, not about where it came from
  const was = before[key];
  const now = after[key];
  if (!Object.hasOwn(before, key)) {
    return { key, kind: 'added', detail: summarize(now) };
  }
  if (JSON.stringify(was) === JSON.stringify(now)) return undefined;
  // the rows the new block no longer carries — named, so the operator
  // reads which curated entries the write takes
  const dropped = droppedRows(was, now);
  return {
    key,
    kind: 'changed',
    detail: `${summarize(was)} → ${summarize(now)}`,
    ...(dropped === undefined ? {} : { dropped }),
  };
}

/** The keys the after-object dropped. */
function removalsOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): SettingsChange[] {
  return Object.keys(before)
    .filter(key => !Object.hasOwn(after, key))
    .map(key => {
      const was = before[key];
      // the whole key goes — every row it carried goes with it
      const dropped = droppedRows(was, undefined);
      return {
        key,
        kind: 'removed' as const,
        detail: summarize(was),
        ...(dropped === undefined ? {} : { dropped }),
      };
    });
}

/** The diff — the keys that change, the after-object's order first. */
export function settingsDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): SettingsChange[] {
  const changed = Object.keys(after)
    .map(key => changeOf(before, after, key))
    .filter((change): change is SettingsChange => change !== undefined);
  return [...changed, ...removalsOf(before, after)];
}

/** The diff, as the operator reads it — one line per changed key, the
 *  dropped rows named under the change that takes them. No cap on the
 *  list: a truncated list would hide exactly the rows the diff exists
 *  to name. */
export function formatSettingsDiff(path: string, changes: SettingsChange[]): string {
  if (changes.length === 0) return `${path}: no change`;
  const lines = changes.flatMap(change => {
    const head = `  ${change.key}: ${change.kind} — ${change.detail}`;
    if (change.dropped === undefined) return [head];
    return [
      head,
      `    dropped ${change.dropped.length} row(s):`,
      ...change.dropped.map(name => `      - ${name}`),
    ];
  });
  return [`${path}:`, ...lines].join('\n');
}
