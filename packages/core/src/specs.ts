/**
 * SpecStore — the `specs` facade: SDD enforcement in the project's own
 * conventions. Connectors (native specs/, speckit, openspec, agent)
 * answer the same questions; commands and hook probes never name a
 * tool. Specs are stable project artifacts — beads are intent-to-change
 * and die, specs are what the project now is.
 */

/** One node of the spec tree — `parent` links a feature spec to its
 *  spec-of-specs; `path` is repo-relative for tools with files. */
export interface SpecNode {
  id: string
  parent?: string
  path?: string
}

export interface SpecStore {
  /** Bead `id` carries a spec under this tool's conventions (the `spec:`
   *  link in the description is checked by the caller, before this). */
  hasSpec(id: string): boolean
  /** Scaffold a spec for `id`; absent on tools that own file creation
   *  (their `remedy` names the tool's own command instead). */
  scaffold?(id: string, opts: { parent?: string; title?: string }): string
  /** Human remediation for a bead missing a spec — the tool's own
   *  language (`bro spec new <id>`, `/speckit.specify`, …). */
  remedy(id: string): string
  /** One policy line for hook context — what SDD means in this setup. */
  policy(): string
  /** The spec tree — spec-of-specs roots down to leaves. */
  tree(): SpecNode[]
}
