# bro — agent's sidekick

`bro` is a CLI carrying agent-workflow mechanics so prompts don't have to:
review debt on merged PRs, the open-PR review loop, and scoped drill frames
over beads. In a repo with `bro.config.json` or `.beads/`:

- `bro act status` is the PR review gate — check it before declaring done;
  `bro act threads` lists unresolved threads, `bro act resolve`/`reply` mutate.
- `bro debt` sweeps review debt; `bro debt next` picks the top open finding.
- `bro drill down`/`up` creates scoped descent frames; an open frame must be
  closed with `--result` before stopping.
- Plugin hooks rehydrate state at session start/post-compaction and block
  Stop while a drill frame or unresolved review threads remain.

Developing bro itself: see CONTRIBUTING.md.
