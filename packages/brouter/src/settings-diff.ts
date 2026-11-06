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
 * printed on its own.
 */

/** One key's change. */
export interface SettingsChange {
  /** the settings key */
  key: string;
  /** what happened to the key */
  kind: 'added' | 'removed' | 'changed';
  /** what changed, in the operator's words */
  detail: string;
}

/** The rows of a model block — the block's own shape. */
function rowCount(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const options = (value as { options?: unknown }).options;
  return Array.isArray(options) ? options.length : undefined;
}

/** One value, said in a few words. */
function summarize(value: unknown): string {
  const rows = rowCount(value);
  if (rows !== undefined) return `${rows} model row(s)`;
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/** One key's change — undefined when the key did not change. */
function changeOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string
): SettingsChange | undefined {
  if (!Object.hasOwn(before, key)) {
    return { key, kind: 'added', detail: summarize(after[key]) };
  }
  if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return undefined;
  return {
    key,
    kind: 'changed',
    detail: `${summarize(before[key])} → ${summarize(after[key])}`,
  };
}

/** The keys the after-object dropped. */
function removalsOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): SettingsChange[] {
  return Object.keys(before)
    .filter(key => !Object.hasOwn(after, key))
    .map(key => ({ key, kind: 'removed' as const, detail: summarize(before[key]) }));
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

/** The diff, as the operator reads it — one line per changed key. */
export function formatSettingsDiff(path: string, changes: SettingsChange[]): string {
  if (changes.length === 0) return `${path}: no change`;
  const lines = changes.map(c => `  ${c.key}: ${c.kind} — ${c.detail}`);
  return [`${path}:`, ...lines].join('\n');
}
