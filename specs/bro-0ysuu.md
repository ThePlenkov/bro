# bro-0ysuu — claude-plugin dogfood scenario

The end-state formula this repo dogfoods: a `claude` session whose
model plane is bro's own conductor (`bro serve` → `devin acp`), with
the `bro@bro` plugin enabled — every feature exercised from inside
the client it's meant to serve. `bro self dogfood` already carries
the runner→analyst formula; this bead adds what a client-wired
scenario needs.

## Changes

- `dogfood/<name>.files/` — a sibling dir of any scenario md whose
  contents are copied verbatim into the scratch repo and committed at
  provision time. Client wiring (`.claude/settings.local.json`,
  helper scripts, `bro.config.local.json`) rides the scenario, not
  the harness code.
- `providers.claude` in `bro.config.json` — a `cli` provider entry
  (`cat {promptFile} | claude -p --permission-mode bypassPermissions`)
  so `bro self dogfood run claude-plugin --provider claude` spawns a
  claude runner through the normal fleet registry path.
- `dogfood/claude-plugin.md` — the scenario: plugin orientation,
  bead→spec→worktree→commit workflow, stop-gate hook check, honest
  stop. Asserts the session ran on the conductor (serve.log +
  `conductor.turn` events are the analyst's evidence).
- `dogfood/claude-plugin.files/` — the scratch's wiring:
  - `.claude/settings.local.json` — apiKeyHelper + `ANTHROPIC_BASE_URL`
    on port 44928 + `devin/swe-2-max` model pins + `bro@bro` enabled.
  - the apiKeyHelper is one line — `npx --no-install bro serve ensure
    --port 44928` — lazy-starts `bro serve` bound to the scratch repo
    and prints that listener's token (superseded the bash helper in
    bro-hc1oy). A scratch never shares port/token with the operator's
    own listener (the `/v1/*` plane gates on the session token).
  - `bro.config.local.json` — the `devin-acp-max` acp provider the
    scratch's conductor serves (`devin acp --model swe-2-max`).

## Non-goals

- The actual dogfood RUN is a separate step once the conductor's
  session-retain path (bro-whn25) is on main — stateless clients
  resend full history per turn, and retain is what makes a claude
  conversation one acp session instead of N fresh ones.
- Interactive claude UX — the runner is `claude -p` headless, which is
  the surface dogfood can verify end-to-end.
