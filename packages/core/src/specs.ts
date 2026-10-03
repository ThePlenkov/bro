/**
 * SpecStore — the `specs` facade: SDD enforcement in the project's own
 * conventions. Connectors (native specs/, speckit, openspec, agent)
 * answer the same questions; commands and hook probes never name a
 * tool. Specs are stable project artifacts — beads are intent-to-change
 * and die, specs are what the project now is.
 */

/** One node of the spec tree — `parent` links a feature spec to its
 *  spec-of-specs; `path` is repo-relative for tools with files.
 *  `parentVia` records how the edge was declared when the tool can tell:
 *  `position` edges resolve to the enclosing dir spec while `frontmatter`
 *  edges resolve deterministically — they diverge when the parent id is
 *  duplicated. */
export interface SpecNode {
  id: string
  parent?: string
  parentVia?: 'position' | 'frontmatter'
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
  /** The tool's *explicit* scope for `id` — repo-relative pathspecs the
   *  spec declares (native: `scope:` frontmatter). Absent on tools
   *  without the concept and null when the spec declares none — both
   *  fall through to the drift engine's commit-refs fallback. */
  scope?(id: string): string[] | null
}
