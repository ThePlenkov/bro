---
parent: sdd
---

# bro-gkbe — bro spec facade: spec tree + SDD tool connectors + init

## Problem

`bro spec` today is a flat per-bead check (`specs/<id>.md` or a `spec:`
link) gated by `sdd.mode`. Two gaps:

1. Specs are leaf-only — there is no spec-of-specs. An epic's design
   mass should decompose into feature/capability specs, mirroring the
   bead tree it governs, and the tool should render and audit that tree.
2. The policy only knows bro's native `specs/` shape. A project running
   speckit (`.specify/`), openspec (`openspec/`), or no tool at all gets
   no enforcement in its own conventions — yet SDD should follow the
   project's setup, not impose ours.

## Design

**Facade.** New `specs` facade on `FacadeMap`; the serving connector is
picked by detection (`connectors.spec` in bro.config.json overrides):

| Connector | Detection | spec shape |
| --------- | --------- | ---------- |
| `native`  | `sdd.dir` exists or nothing else | `<dir>/<bead-id>.md`, `parent:` frontmatter |
| `speckit` | `.specify/` present | `specs/<NNN>-<slug>/spec.md` per feature; bead maps via `spec:` link only |
| `openspec`| `openspec/` present | `openspec/changes/<id>/proposal.md` during work, `openspec/specs/` for shipped capability |
| `agent`   | explicit `connectors.spec: agent` or fallback | no files — connector's probes carry policy text only |

Every connector answers: `hasSpec(id)`, `scaffold(id, {parent})` (or a
remediation line when the tool owns file creation), `policyLine()`,
`tree()` for `bro spec tree`. Hooks keep owning arming — sddConnector's
probes delegate to the resolved spec connector, so the nudge speaks the
project's own tool language.

**Tree.** Native specs gain optional `parent: <bead-id>` frontmatter;
`spec new --parent <id>` sets it. `bro spec tree` renders the hierarchy
(spec-of-specs at the root, leaves under parents, MISSING entries for
claimed beads with no spec). The spec file stays a committed artifact —
beads are intent-to-change and die; specs are what the project now is.

**Bootstrap.** `bro spec init` detects an existing tool and writes the
matching `connectors.spec` + `sdd.mode: remind`; on a bare repo it
scaffolds `specs/` + a root spec-of-specs and sets `mode: remind` —
SDD without any prior configuration.

## Plan

- [ ] `specs` facade + connectors (native, speckit, openspec, agent) with dir detection
- [ ] `bro spec tree` + `spec new --parent` (native)
- [ ] `bro spec init` bootstrap
- [ ] sddConnector probes delegate to resolved connector (policy text per tool)
- [ ] tests: detection, tree render, init scaffold, gate delegation
- [ ] e2e: `devin -p` sessions — repo with plugin+sdd:gate vs bare — evidence report
