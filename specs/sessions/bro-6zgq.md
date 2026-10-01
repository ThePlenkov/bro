# bro-6zgq — drill up --report: durable md report artifact

## Problem

Drill frames return their RESULT + PREVENTION memo into beads — right
for ephemeral coordination, wrong for "I drilled this ON PURPOSE and
want the report visible in the project". Postmortems, investigations,
audits deserve a committed, readable artifact reviewed with the code.

## Design

Beads stay the coordination substrate (claims, frames, deps) — files
are the *output*, not the store. On `bro drill up`:

```text
bro drill up --result "…" --prevent "…" --report
→ drills/<frame-id>.md   (written into the worktree; it rides the
                                  branch like any file — drill up never commits)
```

Report shape — md with frontmatter, template-driven:

```markdown
---
drill: <frame-id>
scope: <what was drilled>
parent-chain: [root, …, frame]
date: <iso>
result: "<one line — quoted scalars: result/prevention text may
          carry colons, newlines, YAML markers>"
prevention: ["<one line>", …]   # list — --prevent is repeatable
---
# drill report — <title>
## Result …  ## Prevention …  ## Trail (children, evidence links)
```

- `drill.report` config section (loaded like other sections via
  loadConfig in the drill command): `dir` (default `drills/`), `mode`
  (`off` default | `prompt` | `always`). `prompt` degrades to `off`
  non-interactively (no TTY → no question, no file). `always` covers
  persistent frames only — ephemeral coordination frames need an
  explicit `--report`, matching the "durable output is intentional"
  rule.
- Fit the existing doctypes store if it absorbs it cheaply; else a
  plain `drills/` dir + `bro drill report` to list them.

## Plan

- [ ] `--report` flag + `drill.report` config on `drill up`
- [ ] report template + frontmatter writer
- [ ] `bro drill report` listing
- [ ] tests + drill SKILL.md row
