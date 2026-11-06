# bro-bm07g — ship `/bro` slash command across agent clients

## Goal

A user types `/bro` in every supported client that has a native command
surface and gets a client-native command — one name. Never a 1:1 mirror
of `bro` argv: the command is a thin pointer to `skills/` + `bro` CLI
mechanics, rendered in each client's own command format.

## Client surfaces (verified)

- **devin** — skills ARE slash commands (`devin skills` — "slash commands
  and agent-triggered context blobs"). `skills/bro/SKILL.md` at plugin root
  gives `/bro` (frontmatter: `description`, `argument-hint`,
  `allowed-tools`, optional `subagent: true`). Root
  `skills/bro/SKILL.md` is the single portable path — project-local
  installs read the same file, never a `.devin/skills/` copy.
- **claude** — plugin commands dir; precedent exists: `commands/models.md`
  (frontmatter `description` + `allowed-tools`, body `!`cmd``). Add
  `commands/bro.md`.
- **codex** — no custom prompt surface; `.codex-plugin/plugin.json`
  resolves `skills` to the repo root, so codex discovers the canonical
  `skills/bro/SKILL.md` directly. No `prompts/bro.md`.
- **opencode** — `command/*.md` convention; wire only if an opencode
  manifest/client files already exist in the repo (check `dogfood/` and
  plugin manifests first — do not invent a client block the spec doesn't
  carry).

## Content shape (shared contract)

`/bro` is a dispatcher, not a clone:

- `/bro` (no args) — orient: `bro status` digest + pointer to
  `skills/<name>` for deep mechanics
- `/bro act [PR]` — point at `bro review act` + the act skill
- `/bro debt` — `bro review debt` family
- `/bro work` — `bro work` family
- `/bro loop`, `/bro fleet` — same pattern

Keep each client's file thin: name the CLI command + the skill to read for
policy, never re-derive mechanics in the prompt text.

## Anti-drift

One canonical content source; per-client files generated or at least
checked by a script like `scripts/gen-config-schema.ts` — add the drift
check to an existing `check:` script/test if one covers generated files
(schema freshness check is the precedent).

## Constraints

- Pure TS repo conventions apply; docs in the client-native markdown each
  surface requires — do NOT duplicate a `skills/` tree into client dirs
  (AGENTS.md rule: portable `skills/<name>/SKILL.md` is the single skills
  home; clients get only client-specific extras).
- Work in this worktree (`bro--bro-bm07g`), branch `bro-bm07g`, PR per repo
  rules, and arm auto-merge per `loop.autoMerge` order:
  `gh pr merge --auto --squash --delete-branch`.
- `bro` on PATH is an older build — `BRO_CONFIG_FORCE=1` bypasses the
  `loop.autoMerge` unknown-key refusal until the binary is rebuilt.
