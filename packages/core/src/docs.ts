/**
 * Doc-type layer — bro's nouns under verb-first dispatch:
 * `bro <verb> [noun|ref] [--flags]`.
 *
 * A plugin registers a DocType: name + adapter factory. The adapter's
 * methods ARE the verb registry — no verb list to declare, nothing to
 * keep in sync. `list`/`get`/`create`/`update`/`remove` are standard
 * verbs with fixed CLI shapes (also reachable as `show`/`new`/`set`/`rm`);
 * every other method becomes a custom verb invoked as
 * `(ref, flags, positional)`.
 *
 * Typing: DocType<TDoc> flows through the plugin descriptor, so adapter
 * authors get checked end-to-end; the argv boundary is the only untyped
 * edge and validates via the descriptor's schema.
 */

/** Where a doc lives. 'global' is the user-level store outside the repo. */
export type Scope = 'project' | 'global'

export interface DocCtx {
  /** Repo root the command was dispatched from. */
  root: string
  scope: Scope
}

/** Parsed `--key=value` / boolean `--key` flags. */
export type DocFlags = Record<string, string>

/** Standard verbs map CLI spelling → adapter method. Any other method
 *  name is itself a verb. */
export const STANDARD_VERBS: Record<string, keyof DocAdapter> = {
  list: 'list',
  show: 'get',
  get: 'get',
  new: 'create',
  create: 'create',
  set: 'update',
  update: 'update',
  rm: 'remove',
  remove: 'remove',
}

/** Custom verb signature — `bro close task-1 -r done` reaches
 *  `adapter.close('task-1', {r:'done'}, [])`. */
export type DocVerb<TDoc = unknown> = (
  ref: string | undefined,
  flags: DocFlags,
  positional: string[]
) => TDoc | TDoc[] | void | Promise<TDoc | TDoc[] | void>

/**
 * The store-facing object. Every enumerable function property is a verb;
 * `_`-prefixed members stay private helpers. Methods receive the
 * already-scoped adapter, so `list` under `--global` just reads a
 * different root — scope is a constructor concern, never a verb arg.
 */
export interface DocAdapter<TDoc = unknown> {
  list?(flags: DocFlags): Iterable<TDoc>
  /** `ref` is undefined on a bare `show` — a scoped adapter (store
   *  --global) may still answer; ref-requiring adapters return nothing
   *  and dispatch reports the missing ref. */
  get?(ref: string | undefined): TDoc | null | undefined
  create?(input: Record<string, unknown>, flags: DocFlags): TDoc
  update?(ref: string, patch: DocFlags): TDoc | void
  remove?(ref: string): void
  [verb: string]: unknown
}

export interface DocType<TDoc = unknown> {
  /** CLI noun — `bro list tasks`, `bro show task <id>`. */
  name: string
  /** Plurals and shorthand (`['tasks']`). */
  aliases?: readonly string[]
  /** Scopes this type supports; including 'global' exposes `--global`.
   *  Defaults to ['project']. */
  scopes?: readonly Scope[]
  /** Ref prefix for `bro show <id>` inference — a ref starting with it
   *  resolves to this type without naming the noun. */
  idPrefix?: string
  /** One-line row for `list` and verb results — default JSON. Method
   *  shorthand keeps TDoc bivariant so DocType<X> stays assignable to
   *  the untyped registry slot. */
  render?(doc: TDoc): string
  /** `show` body — default is pretty JSON of the doc. */
  describe?(doc: TDoc): string
  /** Factory must be cheap — it builds closures, never opens stores.
   *  IO belongs inside the verb methods so a missing store only fails
   *  the verb that needs it. */
  adapter: (ctx: DocCtx) => DocAdapter<TDoc>
}

/** Verb names an adapter exposes — its function members plus canonical
 *  spellings for the standard methods it implements. */
export function docVerbs(adapter: DocAdapter): string[] {
  const verbs = new Set<string>()
  for (const [verb, method] of Object.entries(STANDARD_VERBS)) {
    if (typeof adapter[method] === 'function') {
      verbs.add(verb)
    }
  }
  for (const k of Object.keys(adapter)) {
    if (!k.startsWith('_') && typeof adapter[k] === 'function') {
      verbs.add(k)
    }
  }
  return [...verbs].sort((a, b) => a.localeCompare(b))
}

/** Resolve CLI verb → the adapter method to invoke (standard verbs map
 *  to their method names; anything else is taken literally). */
export function verbMethod(
  adapter: DocAdapter,
  verb: string
): ((...args: never[]) => unknown) | undefined {
  // own-key check — `adapter['constructor']` must not resolve through
  // Object.prototype via a Record index hit on STANDARD_VERBS; and a
  // custom verb spelling an inherited member ('toString', 'hasOwnProperty')
  // must not become invocable through the adapter either
  const name = Object.hasOwn(STANDARD_VERBS, verb) ? STANDARD_VERBS[verb]! : verb
  if (Object.hasOwn(Object.prototype, name)) {
    return undefined
  }
  const method = adapter[name]
  return typeof method === 'function'
    ? (method as (...args: never[]) => unknown)
    : undefined
}

/** A type matches `token` by name or alias. */
export function docTypeNamed(type: DocType, token: string): boolean {
  return type.name === token || (type.aliases?.includes(token) ?? false)
}
