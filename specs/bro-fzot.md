# bro-fzot — commit provenance — agent+model trailers via prepare-commit-msg hook (separate bro commits from human)

## Problem

Machine-made commits are indistinguishable from human ones in `git log`.
The `Co-Authored-By` convention is a prompt rule — agents forget it, it
is not queryable per field, and it cannot correlate commits back to the
session, bead, or molecule that produced them. Consumers that want this
(`git log --grep` filtering, audit, learn analytics like
model → review-debt correlation for orchestrator model choice) need
structured metadata, not prose.

## Design

A `prepare-commit-msg` git hook owned by bro's hook system — installed,
not prompted. On every `git commit` in a bro-enabled repo the hook
resolves provenance from env markers the session exports (plus
best-effort local fallbacks) and appends git trailers to the message
file via `git interpret-trailers --in-place --if-exists doNothing`:

| Trailer | Sources, in order |
| --- | --- |
| `Agent:` | `BRO_AGENT` (pinned by `bro agents` to the backend name) → `AI_AGENT` normalized to the cli name (`devin_3000-11-3_agent` → `devin`) |
| `Agent-Model:` | `BRO_AGENT_MODEL` → runtime vars (`DEVIN_MODEL`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `AI_MODEL`) |
| `Session:` | `BRO_SESSION_ID` (pinned by `bro agents` to the agent id) → runtime vars (`DEVIN_SESSION_ID`, `CLAUDE_SESSION_ID`) → single-live-session marker scan of `<git-common>/bro/hooks/` (exactly one session with live markers → that id) |
| `Bead:` | `BRO_BEAD_ID` → branch name `work/<bead>`/`loop/<bead>` when the tail matches bead shape → the resolved session's `.task` marker detail (exactly one bead) |
| `Molecule:` | `BRO_MOL_ID` → `bd show <bead> --json` `.parent` when the bead resolved |

Policy:

- **Fail-open, always.** The hook exits 0 on any failure; a commit is
  never blocked by provenance.
- **No agent, no trailers.** At least an agent identity (`BRO_AGENT` /
  `AI_AGENT` / `BRO_AGENT_ID` / live session marker) must resolve —
  human commits stay clean.
- **First writer wins.** `doNothing` on existing keys — a trailer the
  committer wrote is never clobbered, and a rebased/amended commit
  keeps its original provenance.
- Trailers are advisory metadata, not a security boundary — a caller
  exporting `BRO_*` can badge its own commits. `bro agents` still
  strips ambient `BRO_*` from spawn env and injects its own pins.

Commands (all under the existing `bro hooks` surface):

- `bro hooks install` — write
  `<git-common>/hooks/prepare-commit-msg` (or `$core.hooksPath/` when
  set) as a shim that runs a pre-existing hook (renamed
  `prepare-commit-msg.local`) then `bro hooks prepare-commit-msg "$@"`.
  Idempotent; `bro` on PATH first, `npx @broject/bro@<version>` fallback
  baked at install time.
- `bro hooks uninstall` — remove the shim, restore
  `prepare-commit-msg.local` if present.
- `bro setup` installs the hook — a repo that opts into bro gets
  provenance without a second step. `bro hooks uninstall` is the
  opt-out.

Spawn pins (`bro agents`, `bro loop`): `BRO_AGENT` (backend name),
`BRO_SESSION_ID` (agent id), `BRO_MOL_ID` (molStep's parent via
`bd show` — best-effort), `BRO_AGENT_MODEL` (when the connector config
knows it). All join `AGENT_PIN_KEYS` — caller-supplied values never
reach the worker.

## Plan

- [ ] `packages/cli/src/commands/githooks.ts` — pure trailer resolver +
      `git interpret-trailers` writer + install/uninstall shim logic
- [ ] `hooks.ts` dispatch: `prepare-commit-msg <file> [source] [sha]`,
      `install`, `uninstall` (before the stdin-payload path — git hooks
      carry argv, not JSON)
- [ ] `agent-connectors.ts`: extend `AGENT_PIN_KEYS` + `agentEnvPins`
      with the new pins
- [ ] `setup.ts`: install during `bro setup`
- [ ] tests: unit (resolver: env, markers, branch, dedup, no-agent
      no-op) + e2e (install → commit → `git log --format=%B` shows
      trailers)
- [ ] docs: `site/content/docs/commands/` hooks page if one exists
