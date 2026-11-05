/**
 * The registry mechanics — what every CLI instance shares.
 *
 * A plugin list is the registry; the groups are DERIVED from it, never
 * a second list that can drift. An external plugin (loaded from a
 * config) joins the same list, so it is dispatchable AND visible in the
 * help.
 */
import type { CommandPlugin } from './plugin.ts';

/** Group name → members, derived over the live registry each call so
 *  an external plugin loaded from config can join a group too. */
export function pluginGroups(plugins: readonly CommandPlugin[]): Map<string, CommandPlugin[]> {
  const groups = new Map<string, CommandPlugin[]>();
  for (const p of plugins) {
    if (!p.group) continue;
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  return groups;
}

/** Is the entry a plugin at all? A plugin is a runnable declaration
 *  with a name and a summary. */
export function isPlugin(entry: unknown): entry is CommandPlugin {
  const p = entry as CommandPlugin | undefined;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.name === 'string' &&
    p.name !== '' &&
    typeof p.summary === 'string' &&
    p.summary !== '' &&
    typeof p.run === 'function'
  );
}

/** What the external registration refused — the caller prints it. */
export interface ExternalRefusal {
  /** the spec the plugin came from */
  spec: string;
  /** the name it wanted */
  name: string;
  /** why it was refused */
  reason: 'not-a-plugin' | 'reserved' | 'taken';
}

/** Register an external plugin into the registry — the acceptance
 *  rules, in the order they matter:
 *
 *  - a plugin name that shadows a reserved word is refused (the host's
 *    own noun/verb layer would lose it);
 *  - a name already in the registry is refused (the builtin wins).
 *
 *  A refusal is reported, never silent. */
export function registerExternal(
  plugins: CommandPlugin[],
  entry: unknown,
  spec: string,
  reserved: ReadonlySet<string> = new Set()
): { plugin?: CommandPlugin; refusal?: ExternalRefusal } {
  if (!isPlugin(entry)) {
    return { refusal: { spec, name: '', reason: 'not-a-plugin' } };
  }
  if (reserved.has(entry.name)) {
    return { refusal: { spec, name: entry.name, reason: 'reserved' } };
  }
  if (plugins.some((p) => p.name === entry.name)) {
    return { refusal: { spec, name: entry.name, reason: 'taken' } };
  }
  const plugin: CommandPlugin = { ...entry };
  plugins.push(plugin);
  return { plugin };
}
