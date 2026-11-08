# bro-0ykhg — brouter: task-routing formulas — classification cascade, invocation modes, outcome feedback, benchmarks

Builds on bro-olfvd.1 (specs/bro-olfvd.1.md — route table, health store,
decision model) and bro-v0pvd.1 (judge-scored complexity × mode → matrix).
Related: bro-l8c4f.9 (specs/bro-l8c4f.9.md — bare agent vs agent + bro).

## What the router is — and is not

brouter routes **tasks** to **agents the user already configured** (opencode,
kilo, Devin, Claude Code, codex, any ACP agent — each with its own model,
skills and settings). It does not route LLM requests: request-level routing,
fallback and cost balancing between model APIs is an LLM gateway's job
(bifrost), not the router's. The unit is a task; the target is a configured
agent lane; the rule is a **formula the user writes**.

The point of an AI step in that rule is to leave static files behind: a
route table pins shapes (`type`, `complexity`, `priority`), but the task
rarely arrives carrying them. A formula in MD says what to ask about the
task, how to weigh the answers, and which hard filters the code keeps —
the user edits prose and a small frontmatter, not a matcher.

## Problem

Today (bro-olfvd.1 S4) the decision model answers one question — "which
route?" — over the routes' prose descriptions, on every task, with no memory
of how the previous routing turned out:

1. **One formula shape.** `routePick` is direct choice over descriptions.
   Feature extraction (bro-v0pvd.1's complexity + mode → matrix) and scoring
   (success vs cost vs latency) have no home in the route table.
2. **A judge call per task.** Even when the rules leave one candidate, the
   fleet on free lanes pays the judge's latency and the same allowance.
3. **No outcome.** The journal records the pick, never whether the task
   landed: merged, how many act rounds, what it cost. A router that cannot
   see results is a classifier of prose, not a policy.
4. **No measurement.** Jev is the only typed-grade judge wired; nothing says
   whether it beats the static table, a small local router model, or a cheap
   hosted one on this repo's own tasks.
5. **Client adapters live inside the router.** Rendering the catalog into
   Claude Code's `modelPicker` (Claude Code the CLI running on other agents)
   is a different product with a different failure mode (client releases).

## Design

| child        | concern                                                         | spec                  |
| ------------ | --------------------------------------------------------------- | --------------------- |
| bro-0ykhg.1  | the MD formula: typed questions, weights, hard filters          | specs/bro-0ykhg.1.md  |
| bro-0ykhg.2  | the cascade T0 rules → T1 recall → T2 judge → T3 escalate       | specs/bro-0ykhg.2.md  |
| bro-0ykhg.3  | the decision cache — an opt-in mode, never the default          | specs/bro-0ykhg.3.md  |
| bro-0ykhg.4  | outcomes: the act verdict flows back into the router            | specs/bro-0ykhg.4.md  |
| bro-0ykhg.5  | the classifier bench: replay the journal across judge models    | specs/bro-0ykhg.5.md  |
| bro-0ykhg.6  | client adapters out of brouter, into their own plugin           | specs/bro-0ykhg.6.md  |
| bro-l8c4f.9  | the lift bench: one prompt, bare agent vs agent + bro (arena)   | specs/bro-l8c4f.9.md  |

Order: .1 → .2 → .3; .4 feeds .1's scoring, .2's T1 recall, and .5's
historical labels; .6 is
independent. bro-l8c4f.9 proves the product claim, .5 proves the router's.

## Non-negotiables (inherited, restated)

- The model answers questions; **code** picks the route, reads the health,
  walks the chain. A model never names a provider.
- Fail-open: no judge, no recall, no cache → table order among candidates
  that pass code-owned hard filters and health; no safe route fails loud.
- `off | shadow | enforce` stays the trust axis. When to ASK the judge
  (bro-0ykhg.2) and whether to REUSE an answer (bro-0ykhg.3) are separate
  axes, not new values of `mode`.
- The router runs without beads, without the bus, without a git repo:
  outcomes arrive through the router's own surface; bro is a reporter.
- Unknown cost is `unknown`, never `0`.

## Verify

Each child carries its own verify block. The epic closes when bro-0ykhg.5
publishes a replay report where the chosen default (`invoke = ambiguous`,
the formula's scoring) is compared against the static table on the same
journal, with outcome-labelled rows.
