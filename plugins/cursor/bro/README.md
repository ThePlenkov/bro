# bro — Cursor plugin

Agent's sidekick for Cursor: review debt, the PR review loop, drill frames,
and wtf→retro. Mechanics live in the `bro` CLI. This directory is the
Cursor plugin — skills plus lifecycle hooks.

## Install

In Cursor:

```text
/add-plugin https://github.com/ThePlenkov/bro
```

Then install **bro** from Customize. The marketplace manifest is
`.cursor-plugin/marketplace.json` at the repo root; this directory is
the plugin it points at.

For a local checkout, symlink `plugins/cursor/bro` to
`~/.cursor/plugins/local/bro`. `skills` in that directory is a link to
the repository `skills/` tree — one copy for every client — so the
adapter has to stay inside the checkout.

Context and stop hooks stay quiet until the workspace opts in
(`bro.config.json` or `.beads/`, which `bro setup` writes). A missing
CLI or a timeout never stalls the session. `beforeShellExecution` still
answers when the workspace has not opted in — Cursor treats an empty
reply as a deny. A plain `bro` / `bd` / `npx @broject/bro` is allowed;
anything else that matched is left as a prompt.

## Hooks

| Cursor hook | bro event | Effect |
| --- | --- | --- |
| `sessionStart` | `session-start` | Rehydrate beads, drill, debt, and PR state |
| `beforeSubmitPrompt` | `prompt-submit` | Prompt context. The first one also rehydrates when `sessionStart` did not run (cloud agents) |
| `preCompact` | `pre-compact` | Drop the rehydration mark so the next prompt reloads state |
| `postToolUse` / `postToolUseFailure` | `post-tool` | Arm the stop gate, cite the governing skill, drain `bro notify` |
| `stop` | `stop` | One follow-up when this session armed a gate (`loop_limit: 1`) |
| `beforeShellExecution` | `permission` | Auto-approve a plain `bro` / `bd` / `npx @broject/bro` command |

A chained command (`bro act status && …`) is not auto-approved.

Requires Node ≥ 22.18. The hook resolves a built checkout, then `bro` on
PATH, then `npx -y @broject/bro@0.2.4`.
