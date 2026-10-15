# bro-j1kk2.8 — generated command reference

19 curated pages in `site/content/docs/commands/` vs ~50 registry
commands — coverage rots by construction. The fix is generation, not
discipline: one page per registry command, emitted from the registry
itself.

## Design

- **`bro plugins --json`** — the bare registry print gains a JSON form
  (name, group, summary, skill, configKey, hidden, aliasOf, plan,
  external). The generator's data source is the shipped binary, the
  same source `--help` uses — never a re-declared list.
- **`scripts/gen-command-docs.ts`** — runs
  `node packages/cli/dist/index.js plugins --json` (requires `npm run
  build` first; errors clearly if dist is absent) and emits
  `site/content/docs/reference/<name>.md` + `meta.json`.
  - one page per public (non-`hidden`) command; `aliasOf` entries get a
    stub page pointing at the canonical page
  - page = frontmatter (`bro <name>`, summary) + signature from the
    registry summary's subcommand list + a metadata table (group,
    skill, config section, plan schema) + guide link where a curated
    `commands/` page owns the command (explicit map in the script —
    wrong links are worse than none)
  - `meta.json` groups pages under `---<Group>---` separators using the
    plugin `group` field, fixed group order
  - `--check` regenerates in memory and diffs disk — the drift gate
- **wiring** — `gen:command-docs` / `check:command-docs` root scripts;
  CI step after `Build` (dist must exist — same position as
  `check:embedded`). Curated `commands/` pages stay — they are the
  guides; `reference/` is the complete index.

## Acceptance

- `node scripts/gen-command-docs.ts` emits a page per public command
  (currently ~40) + grouped meta.json
- `npm run check:command-docs` passes on a fresh checkout+build and
  fails when a page or meta.json is stale
- `bro plugins --json` round-trips through the generator (test in
  plugins.test.ts)
- Site build prerenders `/docs/reference/<name>` pages
