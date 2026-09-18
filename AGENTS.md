# bro — agent's sidekick

`bro` is a CLI carrying agent-workflow mechanics so prompts don't have to:
review debt on merged PRs, the open-PR review loop, and scoped drill frames
over beads. In a repo with `bro.config.json` or `.beads/`:

- `bro act status` is the PR review gate — check it before declaring done;
  `bro act threads` lists unresolved threads, `bro act resolve`/`reply` mutate.
- `bro debt collect` sweeps review debt on merged PRs; `bro debt next`
  picks the top open finding.
- `bro drill down`/`up` creates scoped descent frames; an open frame must be
  closed with `--result` before stopping.
- Plugin hooks rehydrate state at session start/post-compaction and block
  Stop once while a drill frame or unresolved review threads remain — a
  repeated stop is let through (gates, not loops). The stop gate only
  hard-blocks sessions that touched the PR or drill frame (`bro act`,
  `gh pr`, `git push`, `bro drill`/`wtf` arm it via a per-session marker);
  ambient repo state is passive context for everyone else.

Developing bro itself: see CONTRIBUTING.md.
