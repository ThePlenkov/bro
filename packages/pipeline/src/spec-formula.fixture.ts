/** The spec's canonical pipeline formula (specs/bro-7d5nb.md) as TOML
 *  — the ONE fixture every test derives its formula from, so the graph
 *  the parser conformance test parses and the graph the runner tests
 *  drive can never drift apart. Test-only: nothing in index.ts
 *  re-exports it, so it ships nowhere. */
export const SPEC_FORMULA = `
version = 1

[[stages]]
name = "classify"          # G1: dedup, group, rank (judge)
engine = "judge"
verdicts = ["solo", "clump", "duplicate", "defer"]

[[stages]]
name = "route"             # G2: agent/model/orchestrator/now|queue
engine = "judge"
verdicts = ["spawn", "queue", "defer"]

[[stages]]
name = "intake"            # task acceptance — worker validates the spec (DoR)
engine = "intake"
verdicts = ["accepted", "questions", "declined"]

[[stages]]
name = "work"              # spawn via fleet facade → exit taxonomy
engine = "fleet"
verdicts = ["done", "rate_limited", "crash", "stopped"]

[[stages]]
name = "verify"            # DoD — work validated against the item's AC, evidence-backed
engine = "e2e"
verdicts = ["verified", "failed", "unverifiable"]

[[stages]]
name = "review"            # G3: internal review — risk-gated
engine = "judge"
gate_on = "complexity == complex"   # cheap-class items skip
verdicts = ["push", "fix", "abandon"]

[[stages]]
name = "accept"            # customer acceptance — the run's customer signs the evidence
engine = "accept"
verdicts = ["accepted", "rejected", "abandon"]

[[stages]]
name = "merge"             # act gate — threads/CI/reviewers settle
engine = "act-gate"
verdicts = ["landed", "blocked", "dropped"]

[[stages]]
name = "capture"           # G4: self-learn + plan next tasks
engine = "learn"
mode = "always-capture"    # per-item cheap; batch retro is separate
verdicts = ["captured"]

[transitions]
classify = { solo = "route", clump = "route", duplicate = "close", defer = "park" }
route    = { spawn = "intake", queue = "park", defer = "park" }
intake   = { accepted = "work", questions = "park", declined = "close" }
work     = { done = "verify", rate_limited = "route", crash = "retry", stopped = "abandon" }
verify   = { verified = "review", failed = "work", unverifiable = "park" }
review   = { skip = "accept", push = "accept", fix = "work", abandon = "abandon" }
accept   = { accepted = "merge", rejected = "work", abandon = "abandon" }
merge    = { landed = "capture", blocked = "retry", dropped = "close" }
capture  = { captured = "end" }
`;
