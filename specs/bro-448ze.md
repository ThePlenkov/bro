# bro-448ze — bro skills: facade for agent-skill deps — install to .agents/skills, config-declared sources

## Problem

Agent skills a repo _consumes_ (does not author) arrive through the
`skills` CLI (`npx skills add`, vercel-labs/skills): vendored into the
`.agents/skills/` plane — the one in-repo directory ~22 agents read —
linked out into per-agent dirs (`.devin/skills/`, `.claude/skills/`),
and pinned in a committed `skills-lock.json` (source + ref +
computedHash). Today the repo's lock carries 12+ entries, but **nothing
in bro reads it**: the `setup --lock` materialiser landed in #679 and
was dropped by the #775 setup rewrite; `packages/core/src/skills-lock.ts`
survives as an orphan reader with no command behind it.

So a repo cannot _declare_ its skill deps anywhere: contributors
hand-run `npx skills add`, the lock drifts from intent, and skills we
ship ourselves (`skills/<name>/`) never reach the `.agents` plane that
agents actually read on machines where the plugin isn't installed from
the repo root.

Two deliverables share this PR:

1. **`bro skills`** — the facade connector: `skills.install` in
   bro.config declares sources; `bro skills sync` materialises them into
   `.agents/skills/` via the skills CLI; `bro skills list` reconciles
   declared ↔ locked ↔ installed.
2. **`skills/bro-herdr`** — a portable playbook skill: the operational
   contract for orchestrating herdr devin sessions (prevention bead
   bro-5dlsl, retro bro-8kn6x). Content lives in the skill, not here.

## Design

### Config — `skills` section

```jsonc
"skills": {
  "install": [
    "github:herdrdev/herdr/skills/herdr",   // single skill at a repo path
    "github:owner/repo",                    // every skill the repo ships
    "owner/repo",                           // shorthand for github:
    "https://github.com/owner/repo",        // URL passthrough
    "local:skills/bro-herdr"                // in-repo dir → symlink
  ],
  "agents": ["devin", "claude-code"],       // `skills add -a` targets
  "bin": "skills"                           // optional CLI override
}
```

- **`install`** is the declaration — one string per source. Grammar:
  `github:<owner>/<repo>[/<path>]` (a path selects the single skill at
  it — the path's basename is the skill name, e.g. `skills/herdr` →
  `herdr`), bare `<owner>/<repo>`, a full `https://` URL passed through
  verbatim, and `local:<repo-relative-path>` (or `./<path>`) for skills
  the repo authors. Anything else is a config error, reported — never
  silently skipped.
- **`agents`** names the `skills add -a` link targets. Default
  `["universal"]` — the `.agents/skills/` plane only, no per-agent
  link farm. **Hazard, documented not enforced:** an agent whose
  project dir is the bare `skills/` (OpenClaw) links vendored names
  into a plugin repo's own skill tree — operators pinning `agents`
  choose their targets.
- **`bin`** — explicit `skills` executable (path or PATH command), else
  `skills` on PATH, else `npx -y skills`.

### `bro skills sync` — declared → locked → installed

Reconcile, in order:

1. **github/URL sources.** `npx skills add <pkg> [-s <skill>] -a <agents>…
   -y` per source. A `github:` source carrying a path is skipped when
   the lock already records `<basename>` from that repo — re-running
   `add` costs a clone for zero information. Bare repo/URL sources
   re-add every sync (the repo's skill set can grow). `npx` itself
   maintains `skills-lock.json` — bro never writes it.
2. **Reconcile `.agents/skills/` to the lock.** Any lock entry whose
   `<name>/SKILL.md` is absent under `.agents/skills/` →
   `npx skills experimental_install -y` once (the CLI's own
   lock→disk restore; covers fresh clones and the CLI's staging
   prunes).
3. **local: sources.** bro-managed symlink
   `.agents/skills/<name> → <path>` (the bead's "linked for
   dogfooding" — a `skills add ./path` _copy_ stales silently on
   every edit of the real skill). `<name>` is the SKILL.md
   frontmatter `name:`, basename fallback; the link is created or
   repointed, a real directory in the way is left alone and reported.
4. **Verify.** `checkSkillLock(readSkillLock(root), {skillsDir})` —
   the existing core reader — reports `missing`/`drifted` rows; drift
   after a sync means the fetched content no longer matches the pin
   and exits 1. Success prints the per-skill result table.

`bro skills list` is the same reconcile rendered read-only: one row
per declared source and per lock entry — state `ok` / `missing` /
`drifted` / `extra` (locked or on disk but undeclared) / `linked`
(local). `--json` on both (`contract` exits: sync 0 ok · 1
failed-or-drift · 2 usage; list 0 · 2 usage).

### Vendoring policy — the decision

- `.agents/skills/` stays **gitignored** — vendored content,
  regenerable on demand.
- `skills-lock.json` stays **committed** — it _is_ the pin (source +
  `ref` + `computedHash`); the existing
  `checkSkillLock`/`skillFolderHash` contract enforces it.
- Per-agent dirs are per-repo policy — **measured:** `skills add -a
  devin` writes a _copy_ into `.devin/skills/`, not a link, and the
  CLI reconciles (rewrites/prunes) the dir on every add — a committed
  copy drifts silently. Devin already reads `.agents/skills/`
  natively, so bro's own config uses `agents: ["universal"]` and
  carries no `.devin` copies; the pre-existing
  `.devin/skills/typesafe-ai` symlink stays untouched.
- Lockfile hygiene this PR applies: `sourceType: "local"` entries
  whose `source` points at `.agents/skills/` itself (`codescene`,
  `evidence`) are unrestorable on any other clone — removed from the
  committed lock.

### `skills/bro-herdr` — the playbook

`skills/bro-herdr/SKILL.md` — portable (frontmatter `name:
bro-herdr`), the orchestration lessons from bro-5dlsl/bro-8kn6x:
`/goal` as the leading-token contract, gate-named goals, busy-pane
composer queue → `send-keys` CR, `report-agent` live-pane binding,
`report-metadata` vs the workspace-label status surface, and the
workspace→worktree→branch teardown order. It is a `skills/` entry —
installed into `.agents/skills/` by `local:skills/bro-herdr` in this
repo's own config (the dogfood).

## Plan

- [ ] `packages/cli/src/commands/skills-config.ts` — `skillsSection`
  (install string list, agents, bin) + JSON schema
- [ ] `packages/cli/src/commands/skills.ts` — `runSkillsCommand`:
  `sync` + `list` (source-descriptor parse, skills-CLI spawn
  wrapper, local symlink, lock reconcile + drift verify)
- [ ] `plugins.ts` — register `skills` (group `self`,
  `skill: 'skills'`, `configKey: 'skills'`, contract + exits)
- [ ] `skills/skills/SKILL.md` — the plugin's own thin skill doc
- [ ] `skills/bro-herdr/SKILL.md` — the playbook
- [ ] `packages/cli/schemas/cli/skills-list.schema.json` +
  `npm run gen:config-schema`
- [ ] `bro.config.json` — `skills.install`:
  `github:herdrdev/herdr/skills/herdr` + `local:skills/bro-herdr`,
  `agents: ["universal"]`
- [ ] `skills.test.ts` — descriptor parse, section parse, list
  reconcile (spawn injected; no network)
- [ ] `bro skills sync` live — lock + `.agents/skills/` +
  `.agents/skills/bro-herdr` symlink land; `bd close bro-5dlsl`
  on merge
