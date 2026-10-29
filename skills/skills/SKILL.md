---

name: skills
description: "Use when the repo declares agent-skill dependencies (`skills.install` in bro.config.json) or asks how vendored skills land in .agents/skills/. Thin wrapper over `bro skills` — mechanics live in the CLI; this skill carries policy only."
---

# /skills (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro skills` is bro's agent-skill dependency facade: `skills.install`
in bro.config declares sources, `bro skills sync` materialises them into
`.agents/skills/` — the one in-repo plane ~22 agents read — through the
skills CLI (`npx skills add`). `skills-lock.json` is committed and
CLI-maintained (source + ref + computedHash is the pin);
`.agents/skills/` is gitignored — vendored, regenerable on demand.

## Commands

| Command             | What it does                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro skills sync`   | `skills add` per github/URL source, a bro-managed symlink per `local:` dir, `experimental_install` for lock gaps, then verifies the lock — exit 1 on a failed source or reported drift |
| `bro skills list`   | declared ↔ locked ↔ installed reconcile, read-only — `ok` / `linked` / `missing` / `drifted` / `pending` / `extra` (locked or on disk but undeclared) / `error`                        |
| `bro skills --json` | either command's rows as JSON                                                                                                                                                          |

## Source grammar

```jsonc
"skills": {
  "install": [
    "github:owner/repo/skills/name",  // one skill at a repo path
    "github:owner/repo",              // every skill the repo ships
    "owner/repo",                     // github shorthand
    "https://github.com/owner/repo",  // URL passthrough
    "local:skills/name"               // in-repo dir → symlink
  ],
  "agents": ["devin"],   // `skills add -a` link targets; default ["universal"]
  "bin": "skills"        // optional CLI override (path or PATH command)
}
```

- `github:` with a path picks one skill — the path's basename is the
  skill name (`skills/herdr` → `herdr`). Skipped on re-sync when the
  lock already records it.
- `local:` (or `./path`) is the dogfood leg: `.agents/skills/<name>`
  becomes a symlink **to the repo dir**, not a copy — editing
  `skills/name` is live for every `.agents`-reading agent. A real
  directory in the way is left alone and reported, never deleted.
- `agents` selects per-agent targets (`.devin/skills/`,
  `.claude/skills/`…). Default `["universal"]` writes only the shared
  plane — usually what you want: `-a <agent>` **copies** (not links)
  into the per-agent dir and the CLI reconciles it on every add, so a
  committed copy drifts silently, while `.agents`-reading agents (incl.
  devin) see the shared plane anyway. Careful pinning it: an agent
  whose project dir is the bare `skills/` (OpenClaw) links vendored
  names into a plugin repo's own skill tree.

## Vendoring policy

`.agents/skills/` is **not** committed — the lock is. A fresh clone
gets everything back with `bro skills sync` (the CLI's
`experimental_install` restores what the lock pins). Per-agent dirs
are repo policy — copies the CLI rewrites on every add, so keep them
uncommitted (bro's own repo uses `agents: ["universal"]`).

Drift — content that no longer matches the lock's computedHash — is a
finding, not a silent update: `sync` reports it and exits 1.
