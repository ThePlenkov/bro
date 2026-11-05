/** The spec's canonical pipeline formula (specs/bro-7d5nb.md) as TOML
 *  — the ONE fixture every test derives its formula from, so the graph
 *  the parser conformance test parses and the graph the runner tests
 *  drive can never drift apart. Test-only: nothing in index.ts
 *  re-exports it, so it ships nowhere. */
export const SPEC_FORMULA = `
version = 1

[[stages]]
name = "classify"
engine = "judge"
verdicts = ["solo", "clump", "duplicate", "defer"]

[[stages]]
name = "route"
engine = "judge"
verdicts = ["spawn", "queue", "defer"]

[[stages]]
name = "work"
engine = "fleet"
verdicts = ["done", "rate_limited", "crash", "stopped"]

[[stages]]
name = "review"
engine = "judge"
gate_on = "complexity == complex"
verdicts = ["push", "fix", "abandon"]

[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["landed", "blocked", "dropped"]

[[stages]]
name = "capture"
engine = "learn"
mode = "always-capture"
verdicts = ["captured"]

[transitions]
classify = { solo = "route", clump = "route", duplicate = "close", defer = "park" }
route    = { spawn = "work", queue = "park", defer = "park" }
work     = { done = "review", rate_limited = "route", crash = "retry", stopped = "abandon" }
review   = { skip = "merge", push = "merge", fix = "work", abandon = "abandon" }
merge    = { landed = "capture", blocked = "retry", dropped = "close" }
capture  = { captured = "end" }
`;
