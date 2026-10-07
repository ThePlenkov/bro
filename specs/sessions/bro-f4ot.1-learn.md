# bro-f4ot.1 — bro learn — self-improvement loop

Parent: `bro-f4ot` (agents facade + bro fleet) → `sessions` capability.
See `bro-f4ot/spec.md` and `spec.md`.

## Problem

Every iteration produces learnings — a drill prevention memo, a retro
root cause, a reviewer finding that kept recurring, a hard-won answer to
a codebase question — and almost all of them die in session transcripts.
The survivors get hand-edited into `AGENTS.md` recurrence rules: manual,
delayed, and unconditional (an always-on rule about `act` loads even in
sessions that never touch a PR). The system needs the loop the
recurrence convention approximates: capture a lesson with its trigger,
store it durably, and inject it exactly when the trigger fires.

## Terms

- **lesson** — one durable unit of agent knowledge: a rule or fact plus
  the trigger that decides when it surfaces. Not a bead, not a memory —
  see Store.
- **trigger** — the declarative matcher on a lesson: hook events plus
  context conditions (terms, commands, paths, tools, errors).
- **session trace** — the per-session journal of tool landings
  (commands run, paths touched, errors seen) the hooks layer already
  sits on; the matcher's evidence plane for `post-tool` triggers.
- **harvest** — distilling a finished artifact (drill frame, retro bead,
  act/debt outcome, molecule run) into trigger-shaped lessons.
- **promotion** — a lesson graduating out of the store into a rule edit
  (skill / AGENTS.md / rules file) via a bead — the permanent fix the
  lesson was approximating.

## Lesson schema

```ts
interface Lesson {
  id: string                    // learn-<slug> — stable, dedup key
  trigger: LessonTrigger
  lesson: string                // the rule — imperative, quotable as one line
  evidence: Evidence[]          // where it was learned — never empty
  confidence: 'tentative' | 'established' | 'proven'
  source: 'manual' | 'capture:drill' | 'capture:retro' | 'capture:act'
        | 'capture:mol' | 'probe'
  createdAt: string             // ISO
  updatedAt?: string
  promotedTo?: string           // bead/PR ref once graduated to a rule edit
}

interface Evidence {
  kind: 'bead' | 'pr' | 'session' | 'command' | 'text'
  ref: string                   // bead id, PR url, session id, or literal
}

interface LessonTrigger {
  /** Hook events the lesson may fire on — at least one. */
  on: Array<'session-start' | 'prompt-submit' | 'post-tool'>
  /** Conjunctive across keys, disjunctive within a list: every present
   *  key must hit, any list entry satisfies its key. */
  match?: {
    terms?: string[]      // substring, case-insensitive — vs prompt text,
                          // claimed-bead titles/labels, trace lines
    commands?: string[]   // prefixes vs exec commands in the session trace
                          // ('gh pr merge', 'bro act resolve', 'git push')
    paths?: string[]      // globs vs paths touched in the trace / worktree
                          // ('packages/act/**', 'specs/**', 'bro.config.json')
    tools?: string[]      // tool names in the trace ('exec', 'edit', 'write')
    errors?: boolean      // trace shows ≥1 failed tool landing this session
  }
  /** Max fires per session (default 1) — a post-tool lesson must not
   *  nudge on every tool landing. */
  budget?: number
}
```

`evidence` is load-bearing, not decorative: capture dedup keys on
source refs, confidence derives from evidence count and independence,
and a lesson that cannot cite where it was learned is not storable.

`confidence` ladder: **tentative** = one evidence item, unverified;
**established** = ≥2 independent evidences, or one evidence where the
lesson already held under a real gate (the PR it warned about merged
green, the prevention it stated closed the retro); **proven** = survived
re-injection — fired at a trigger and the session it fired into did not
repeat the mistake (recorded by the matcher as a hit/outcome pair, v2 —
v1 promotes on evidence count alone and never blocks on the ladder).

## Store — `bd kv`, not `bd remember`

Lessons persist in the repo's beads Dolt store as `bd kv` entries:
key `learn/<id>`, value the `Lesson` JSON. Enumeration is `bd kv list`
filtered on the `learn/` prefix; reads are exact `bd kv get`; deletes
are `bd kv clear`. Dolt sync via `refs/dolt/data` makes lessons
cross-session and cross-machine for free, and the store inherits the
same stealth property as beads — nothing lands in git.

Why not `bd remember`: memories are the **always-on** channel — they
inject unconditionally at `bd prime`. Lessons exist precisely to be
trigger-gated; storing them as memories floods every session with every
lesson and recreates the AGENTS.md problem in a new place. `remember`
stays right for context-free knowledge ("repo uses native TS"); `learn`
owns conditioned knowledge ("when running `gh pr merge`, sweep debt").

Why not beads: a lesson is not work — it has no open/closed lifecycle,
no assignee, no priority. Beads enter the model only at promotion time
(the rule-edit action) and as evidence refs.

`bro learn` writes through `bd` — the CLI never opens Dolt itself.
Schema validation happens in `@broject/learn` at read: a kv entry that
fails the schema is skipped with a warn line, never a crash (lessons
written by a newer bro must not wedge an older one — same
fail-open-as-skip rule spec parsing already follows).

## Injection — the `learn` connector

A `learn` connector registers alongside the built-ins and contributes
three probes. All three are fail-open and budget-capped like every
probe — a wedged store yields zero lines, never a stalled hook.

- **`sessionStart`** — match `on: session-start` lessons against session
  context: repo name, branch, this session's claimed beads (titles +
  labels), in-progress mol steps, and the previous session's trace tail
  when resumable. Resumable discovery is pinned, not invented — and
  pinned to what the hooks actually receive: **no host supplies a
  prior-session id**, `HookInput` carries `session_id` and nothing else
  resumable (Cursor only renames `conversation_id` into it), so there
  is no resume field to honour and the probe discovers the tail purely
  by fallback. Newest mtime wins among `trace/*.jsonl` entries that are
  **not this session's own file** and **not owned by a provably live
  session**: a live session's trace is concurrent work, not a resume
  tail, so it is skipped via the same `markerLive` read the
  parallel-work nudge uses (owned marker — its pid lives; ownerless —
  inside the 24 h window). No markers for a candidate proves nothing
  and leaves it eligible; unverifiable is not live, and an advisory tail
  beats silence. Candidates older than the 7-day marker TTL are past the
  bound, and nothing eligible — no `trace/` dir yet, every candidate
  live or stale — yields zero lines like any other failed probe. If a
  host ever ships a prior-session field, it wins over the fallback and
  the probe reads `trace/<prior>.jsonl` by name; that lands as a
  `HookInput` widening in hooks, not as a field this spec assumes.
  Matched lessons render as context lines under the rehydration block.
- **`promptSubmit`** — match `terms` against the raw prompt. This is the
  highest-precision trigger (the user just said the thing the lesson is
  about) and the cheapest (no store scan beyond the terms index).
- **`postTool`** — match `commands`/`paths`/`tools`/`errors`/`terms`
  against the session trace. To give the matcher its evidence plane, the
  hooks layer gains a **session trace journal**: `emitPostTool` appends
  one JSONL line per event to
  `<git-common>/bro/hooks/trace/<session>.jsonl` —
  `{ts, tool, command?, paths?, ok}` — per-session keyed like the arming
  markers but **in a `trace/` subdir, never flat beside them**:
  `readArmed` scans `<session>.*` files as gate aspects within the
  marker TTL, so a flat `<session>.trace.jsonl` would arm a phantom
  `trace.jsonl` aspect on every post-tool event (the `hinted/` subdir
  exists for exactly this reason — same rule applies here). The subdir
  sits **below** the dir `armSession` prunes, so — like `hinted/` —
  each subdir prunes itself at the marker TTL or the journals
  accumulate one file per session forever. Two failure modes, two
  bounds. *Stale files:* the sweep rides the write that can afford it
  — `trace/` when a session creates its journal (the
  once-per-session tick; a weekly TTL doesn't need a dir scan on every
  post-tool event), `fired/` on every append — each best-effort at the
  same TTL as the marker prune. *One huge file:* crossing 256 KiB
  trims the journal — the oldest lines drop, the newest 500 stay (well
  past the 100-line tail read), so a long session never grows a file
  every probe re-reads whole. 256 KiB is the trim trigger, not a
  file-size cap: entries carry no size limit, so the kept tail can
  still sit above it. The learn probe reads the trace tail, matches,
  and renders at most `budget` fires per lesson per session — the fired
  set lives in `fired/<session>` under the same `<git-common>/bro/hooks/`
  dir (subdir for the same reason) so restarts don't re-fire.

  The journal records what the hook payload actually carries —
  `HookInput` widens to read `tool_name` and the path-bearing
  `tool_input` fields each tool family uses (`command` on exec,
  `file_path`/`path` on edit/write, `files` where present). Fields the
  payload lacks stay absent from the trace line — a `paths`/`tools`
  trigger key on a tool family that never reports them simply can't
  match, which degrades the lesson to its other keys rather than
  misfiring.

  The trace is the reusable part: it is also what a future `stopGate`
  "did you repeat a mistake a lesson warned about" contribution reads.
  Hooks own the journal write (they already parse tool_input);
  connectors only read — the hook keeps owning arming policy.

Matched lessons inject through the existing
`{hookSpecificOutput: {additionalContext}}` channel — dynamic guards at
zero cost until fired.

## Capture — `bro learn capture`

`bro learn capture [--source drill|retro|act|mol|all] [--mol <id>] [--dry-run]`
distills finished artifacts into trigger-shaped lessons:

- **drill** — closed drill frames' prevention memos and `prevention`
  beads: the memo text becomes the lesson, the frame's scope (paths,
  command) becomes the trigger match, the bead id the evidence.
  Prevention items auto-promote: a closed prevention bead with a
  `sink:` route is captured without a flag.
- **retro** — retro beads recorded by `bro retrospect record`: root
  cause + prevention actions → lesson + trigger; the retro bead id and
  originating `wtf` bead are evidence.
- **act** — closed `debt` findings and resolved review threads:
  recurring reviewer findings (same normalized finding across PRs)
  become lessons triggered on the paths/commands that attracted them.
- **mol** — `--mol <id>` harvests a closed molecule: per-step `--result`
  lines flagged as learnings, plus any drill/retro artifacts the run
  produced.

Dedup is by normalized lesson text plus evidence union: re-capturing a
source merges new evidence refs and recomputes confidence instead of
writing a second lesson. `--dry-run` renders the would-be lessons —
capture is a proposal surface, and the agent (or a review thread)
decides nothing it can't see.

## Probe — `bro learn probe`

Proactive acquisition, two phases under one verb:

```text
bro learn probe <question>                     phase 1 — store-first query
bro learn probe <question> --lesson "<answer>" [--on …] [--match-… …]
                                               phase 2 — store the distilled answer
```

Phase 1 ranks stored lessons against the question's terms — a hit
short-circuits (the knowledge was already paid for). On a miss it
emits the question plus gathered candidates (trace/store context the
matcher can offer cheaply) and the question is logged to the fired set
as an open gap. Phase 2 stores the session-distilled answer as a
`source: probe` lesson — one investigation's output becomes the next
session's trigger-indexed knowledge, which is the entire point of the
loop: probing is how a session *asks*; the stored lesson is how the next
session never has to.

## CLI surface

```text
bro learn add --lesson "<rule>" --on <event>…
              [--match-terms …] [--match-commands …] [--match-paths …]
              [--match-tools …] [--match-errors] [--budget N]
              --evidence <kind>:<ref>…          → stores a manual lesson —
              ≥1 --evidence REQUIRED (schema: never empty); `capture`
              synthesizes evidence from source ids and `probe --lesson`
              auto-records {kind:'session', ref:<probe session>} plus the
              question — only `add` asks for it by hand
bro learn list [--json] [--source …] [--confidence …]
bro learn show <id>
bro learn forget <id>                          → bd kv clear learn/<id>
bro learn capture [--source …] [--mol <id>] [--dry-run]
bro learn probe <question> [--lesson … --on … --match-… …]
bro learn promote <id>                         → opens the rule-edit bead
```

`<event> ∈ session-start|prompt-submit|post-tool` — `--on` is
repeatable like `--evidence`/`--match-*`; each occurrence appends to the
trigger's `on` array (a lesson may fire on several events).

`promote` does not edit skills or AGENTS.md itself — it opens a bead
carrying the lesson, its evidence, and the proposed rule text; the edit
lands through the normal spec/PR path and the lesson records
`promotedTo`. A promoted lesson keeps firing until the rule lands
(the gap between "we know" and "the rule is written" is exactly where
repeats happen), then goes quiet.

Config section (plugin-shaped growth): `learn` in `bro.config.json` —
`{enabled?, maxInject?: number, sources?: string[]}` — `maxInject` caps
lines any single probe may emit (default small; injection is a budget,
not a dump).

## Filetree

```text
packages/learn/src/lesson.ts        schema + validation + confidence
packages/learn/src/store.ts         bd kv CRUD (learn/ prefix)
packages/learn/src/match.ts         trigger matching (session ctx, prompt, trace)
packages/learn/src/capture.ts       drill/retro/act/mol harvest + dedup
packages/learn/src/probe.ts         store-first query + gap log
packages/learn/src/connector.ts     learnConnector — the three probes
packages/cli/src/commands/learn.ts  bro learn <verb>
packages/cli/src/commands/hooks.ts  session trace journal append (emitPostTool)
skills/learn/SKILL.md               policy only — mechanics live in the CLI
```

## Milestones

1. `bro-f4ot.1.1` this spec.
2. `bro-f4ot.1.2` store — schema + `bd kv` CRUD; `bro learn
   add|list|show|forget`.
3. `bro-f4ot.1.3` inject — session trace journal in hooks.ts, matcher,
   `learn` connector probes, fired-set dedup.
4. `bro-f4ot.1.4` capture — drill/retro/act/mol harvest with
   evidence-union dedup; auto-promote of routed prevention items.
5. `bro-f4ot.1.5` probe — store-first query + phase-2 record.
6. `bro-f4ot.1.6` docs+tests — `skills/learn/SKILL.md`, AGENTS.md row,
   tests for store/matcher/capture/probe, embedded regen, CHANGELOG.

## Risks named up front

- **Injection spam.** A lesson that fires on every post-tool event is
  worse than no lesson — `budget` (default 1/session) and `maxInject`
  cap it; the fired set makes re-fires explicit, not accidental.
- **Store-vs-memory confusion.** Contributors will reach for
  `bd remember` because it exists; the spec decision is recorded in
  Store and enforced by the `learn/` kv prefix — lessons are only
  lessons if the matcher controls their surfacing.
- **Trigger rot.** A lesson whose trigger never fires is dead weight
  indistinguishable from a working one. `bro learn list` surfaces
  fire-count/last-fired once the matcher records hits (v2); until then
  `probe` and `capture --dry-run` are the audit surface.
- **Prompt-submit cost.** Terms matching runs per prompt — the terms
  index must be built once per hook invocation from `kv list`, not per
  lesson, or the hook grows linearly with the store.
