---

name: mode
description: "Use when the session should change how much bro does for it — `bro mode` shows/sets the per-session behavior mode (observe|plan|code|review|orchestrate). observe is passive (visibility only); the active modes opt into rehydration, gates, nudges, and connector probes. Run `bro mode code` (or plan/review/orchestrate) inside the session to activate; `bro mode off` returns to passive. Requires `bro` (npx -y @broject/bro@0)."
---

# /mode (bro)

Every agent session on the machine resolves one behavior mode —
`observe` by default. The mode decides what the hook pipeline does on
every event: passive sessions still land in the ledger and get inbox
delivery, but skip rehydration, stop gates, nudges, and most connector
probes. Active modes pay the full pipeline.

## Commands

```bash
bro mode                          # this session's effective mode + source
bro mode code                     # activate — full interactive behavior
bro mode plan     # planning/rehydration mode
bro mode review   # review/debt mode
bro mode orchestrate  # supervisor duties on top of code
bro mode off                      # pin observe even under modes.default
bro mode clear                    # drop the file → modes.default / observe
bro mode list [--json]            # every session mode on the machine
bro mode render [--mode <m>]      # re-render Tier-1 snapshots
```

`bro mode <name>` run inside an agent shell binds to the calling
session through the post-tool hook even when session env is not
visible — the file lands under `$XDG_STATE_HOME/bro/sessions/` and the
ledger projection updates itself.

## Modes

- `observe` — passive. Ledger/spool record everything; inbox delivery
  stays on; no rehydration, no parallel-work nudges, no goal/heartbeat,
  no armed-work stop gates, no guard sweep. Safety vetoes (session-cap
  pre-tool, `preTool`/`permission` answers) still apply.
- `plan` — rehydration + ready tasks + specs/plan context.
- `code` — today's full interactive behavior (arming, gates, nudges,
  beads, worktree, sdd, pulses).
- `review` — act gate, threads and PR context.
- `orchestrate` — supervisor duties on top of code.

Project policy: `bro.config.json` `"modes": {"default": "code"}` makes
every session in the repo start active; a per-session `bro mode` file
always wins, and `bro mode off` pins a session passive anyway.
