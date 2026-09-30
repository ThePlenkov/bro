# bro-0fc — bd default vs opt-in for fresh repos

## Problem

`bro debt collect` silently runs `bd init --stealth --skip-agents
--skip-hooks` in a repo missing `.beads`. For a tool courting adoption,
auto-mutating someone's repo without a word is a surprise — even a benign
one. The open question was whether `beads` belongs in the default
`stores` at all, or whether `jsonl` should be the default with beads
opt-in.

## Decision

**Beads stays a default store. The defect was silence, not the init.**

The auto-init is already non-invasive by construction: `bd init --stealth`
writes `.beads/` into `.git/info/exclude` — nothing lands in git, no
hooks, no `AGENTS.md` edits, nothing is pushed, and `rm -rf .beads`
reverses it. That is the same machine-local contract bro already applies
to `.agents/review-debt/` (auto-created + auto-excluded on first write)
and to the gitignored `bro.config.json`.

`jsonl`-by-default was rejected:

- **It starves the queue quietly.** The ledger is evidence; beads is the
  work queue (`bd ready -l debt`, drill frames, wtfs, retros, `bro next`,
  `bro loop`). A default-off projection fills the log while the queue
  stays empty until the user discovers a config key — a worse surprise
  than a local `.beads` dir.
- **It doesn't remove the dependency.** Task commands (`drill`, `next`,
  `loop`, `convoy`, `retrospect`, `wtf`) hard-require `bd` with no jsonl
  fallback — beads IS their store. Opt-in only defers the requirement to
  a later, less predictable failure.
- **Failure modes are already honest.** A missing `bd` fails the collect
  after evidence is written and names the opt-out; bd API drift degrades
  to jsonl-only with a warning (bro-y1b). `"stores": ["jsonl"]` remains
  the one-line opt-out.

## Design

The init announces itself instead of running silently. `debt checkBeads`
(the auto-init path shared by `debt collect` and `debt sync`) prints one
stderr line when `initBeadsStealth()` actually initializes — matching the
message `bro setup --beads` already prints, plus the opt-out pointer.
`initBeadsStealth` stays silent itself: it returns a bool precisely so
each caller can announce in its own voice.

The init also only fires when there is something to queue. `debt collect`
skips the beads projection entirely on `--dry-run`, on `--list-only`
(read-only inspection), and when the ledger is empty — a clean sweep on a
fresh repo creates no `.beads`. Explicit `bro debt sync` still inits:
asking to sync is asking for the queue.

## Plan

- [ ] debt `beads.ts`: announce on `initBeadsStealth() === true`
- [ ] cli `debt.ts`: collect skips the projection on `--list-only` and
      empty ledgers — no init without something to queue
- [ ] debt `beads.test.ts`: announce on init, once; silent when `.beads`
      exists; no init + no announce under `autoInit: false`
- [ ] README + docs: record the decision — beads default, init announced,
      opt-out is `"stores": ["jsonl"]`
- [ ] skills/debt: policy bullet notes the announce
