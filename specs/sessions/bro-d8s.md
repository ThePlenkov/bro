# bro-d8s — hook/policy: mutations through bro subcommands cite their governing skill

## Problem

Skills activate on user-facing triggers (`/act`, `bro:` pings) — a shell
call like `bro act resolve` mid-flow loads nothing, so policy enforcement
falls back to agent memory, which fails under context pressure (retro
bro-cj0: silent-resolve violated twice despite the rule living in both
SKILL.md and AGENTS.md). bro-1kk added a point-of-use stderr note inside
`act resolve`; the general mechanism — naming the governing skill at the
mutation boundary — does not exist, and the same gap covers debt, drill,
wtf/retrospect, work, convoy, next, loop, sync.

## Design

The post-tool hook already watches every exec command, classifies bro
invocations, and arms per-session aspects. Extend it:

- `classifySkillMutation(cmd)` maps a mutating `bro <cmd> <verb>` (and
  `npx @broject/bro …`) to its governing skill name. Reads never cite —
  the hint exists because prose doesn't reach the point of use, so it
  fires only on calls that change state:
  - verb tables: `act` resolve|reply|merge (`wait` only with
    `--merge`/`--cleanup`), `drill` down|up|distill, `retrospect`
    capture|record, `debt` collect|mark|set|sync, `work` enter|leave|prune,
    `convoy` pour|claim|done, `spec` new
  - bare mutations: `next` (claims; `--list` is a read), `loop`
    (`--dry-run` is a read), `sync`, `unwind` (alias for `drill up`)
  - `wtf` mutates when it carries any argument (bare `bro wtf` is status)
- Once per session per skill: a dedup marker under
  `<git-common-dir>/bro/hooks/hinted/<session>.<skill>` — a subdir keeps
  arming markers pure (`readArmed` scans `<session>.*` suffixes as gate
  aspects). Marker TTL matches the arming TTL; stale markers re-hint.
- The hint is a PostToolUse `additionalContext` line naming the skill and
  its SKILL.md — emitted alongside (not instead of) the existing
  pr-merge/pr-create lines.

No CLI-side stderr change in this bead — the hook covers plugin-installed
sessions, which is where skills exist to be cited. Non-hook environments
(humans, bare scripts) get nothing.

## Plan

- [ ] `classifySkillMutation` + hint markers + `emitPostTool` wiring in
      `packages/cli/src/commands/hooks.ts`
- [ ] classifier tests in `hooks.test.ts` (verbs, bare mutations, quoted
      args, reads produce no hint)
- [ ] `npm test`
