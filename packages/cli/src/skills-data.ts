/**
 * Thin skill wrappers `bro setup --skills` drops into `.agents/skills/`.
 * Policy only — every mechanic named here is a `bro` command. Keep in sync
 * with skills/bro-* in the repo root (same content, this is the
 * distributable copy).
 */
export const SKILL_FILES: Record<string, string> = {
  'bro-debt/SKILL.md': `---
name: bro-debt
description: "Use when the user invokes /debt or asks about review debt on merged PRs. Thin wrapper over the bro CLI — all mechanics live in 'bro debt' commands; this skill carries policy only. Requires bro (npx @theplenkov/bro) and gh."
---

# /debt (bro)

**All mechanics live in the \`bro\` CLI.** This skill is policy only — do not
reimplement what \`bro debt\` already does.

Prereq: \`bro\` on PATH or \`npx -y @theplenkov/bro\`. Requires \`gh\` auth.

## Commands

| Command | What it does |
| ------- | ------------ |
| \`bro debt collect [filters]\` | Scan merged PRs **without** a \`debt:*\` label → collect unresolved threads → write \`harvests/*.jsonl\` → label \`debt:collected\` / \`debt:clean\` |
| \`bro debt status\` | Ledger summary + unprocessed merged-PR count |
| \`bro debt prs\` | Merged PRs still unprocessed — the work queue (\`--all\`: full matrix) |
| \`bro debt list\` | Ledger rows (\`--status\`, \`--area\`, \`--author\`, \`--priority\`, \`--pr\`) |
| \`bro debt mark <pr> <state>\` | \`collected\` / \`clean\` / \`skipped\` / \`none\` — manual override |
| \`bro debt set <status> --thread-id ID\` | Ledger status: done / wontfix / claimed — feeds \`bro debt sync\` |
| \`bro debt sync\` | Project the ledger into beads — \`bd ready -l debt\` becomes the work queue |

## Policy

- **\`debt:*\` labels are the PR-level source of truth** for "processed".
  \`skipped\` is a human opt-out and always wins over machine labels.
- **Label after the file lands.** In CI pipelines run
  \`collect --no-label\`, land \`harvests/*.jsonl\`, then \`bro debt mark\`.
- **Collect, don't fix.** Triage → backlog, fixes → the fix loop. bro-debt
  never edits product code or resolves threads on source PRs.
- \`--reharvest\` bypasses the label skip for one run.
`,

  'bro-debt/agents/openai.yaml': `interface:
  display_name: "Bro Debt"
  short_description: "Review-debt pipeline via the bro CLI — collect + status"
  brand_color: "#B60205"
  default_prompt: "Use $bro-debt to get started."
policy:
  allow_implicit_invocation: false
`,

  'bro-act/SKILL.md': `---
name: bro-act
description: "Use when the user invokes /act on an open PR — the review-fix loop. Thin wrapper over the bro CLI: 'bro act status' is the exit gate as code; resolve/reply are mutations. Requires bro (npx @theplenkov/bro) and gh."
---

# /act (bro)

**All mechanics live in the \`bro\` CLI.** This skill is policy only — do not
reimplement what \`bro act\` already does.

Prereq: \`bro\` on PATH or \`npx -y @theplenkov/bro\`. Requires \`gh\` auth.

## Commands

| Command | What it does |
| ------- | ------------ |
| \`bro act status [PR] [--json]\` | PR state + **exit gate** — open threads, pending CI, SAST findings. Exits non-zero while blocked |
| \`bro act threads [PR]\` | Unresolved review threads, TSV |
| \`bro act resolve --thread ID [--comment T]\` | Resolve a thread (reply first if comment given) |
| \`bro act reply --thread ID --comment T\` | Reply without resolving (\`--file TSV\` for batch) |

## Policy

- **Loop until the exit gate is green.** \`bro act status\` returns non-zero
  with named blockers — keep fixing until it passes; do not self-declare done.
- **Every thread gets a verdict**: fix → resolve with a commit reference, or
  reject as false-positive **with a stated reason** — never silently resolve.
- **Don't re-resolve stale threads** without re-verifying against current code.
- Debt rows from \`bro debt list\` become work via \`bro debt set claimed\` →
  fix → \`bro debt set done --fix-pr N\` → \`bro debt sync\` closes the bead.
`,

  'bro-act/agents/openai.yaml': `interface:
  display_name: "Bro Act"
  short_description: "Open-PR review-fix loop via the bro CLI — exit gate as code"
  brand_color: "#0E8A16"
  default_prompt: "Use $bro-act to get started."
policy:
  allow_implicit_invocation: false
`,
}

/**
 * Beads workflow formulas `bro setup --beads` installs into
 * `.beads/formulas/`. Source of truth: formulas/ in the repo root.
 */
export const FORMULA_FILES: Record<string, string> = {
  'debt-pipeline.formula.toml': `# bro debt pipeline — merged-PR review debt, end to end.
#
#   collect → triage (HUMAN GATE) → fix → pr-gate → merge (HUMAN GATE) → sync
#
# Installed by \`bro setup --beads\`. Run: \`bd mol pour debt-pipeline\`
# (add --var scope="--last 20" to narrow the sweep)

formula = "debt-pipeline"
description = "Sweep merged PRs for unresolved review threads, human-triage them into the ledger, fix them on a branch, gate the fix PR, then project results back to beads."
version = 1
type = "workflow"

[vars.scope]
description = "Extra 'bro debt collect' args, e.g. \\"--last 20\\" or \\"--merged-since 2025-01-01\\""
required = false
default = ""

[vars.fix_pr]
description = "PR number carrying the fixes (filled at the fix step; pr-gate re-checks it)"
required = false
default = ""

[[steps]]
id = "collect"
title = "bro debt collect — sweep merged PRs"
type = "agent"
description = """
Run \`bro debt collect {{scope}}\` in the repo. It scans merged PRs without a
\`debt:*\` label, writes harvests/*.jsonl, labels PRs collected/clean, and —
when store=both — projects findings into beads.
Done when: \`bro debt status\` shows no unprocessed merged PRs.
"""

[[steps]]
id = "triage"
title = "HUMAN GATE — triage the ledger"
needs = ["collect"]
type = "human"
description = """
Human reviews \`bro debt list\`. For each row decide:
  \`bro debt set claimed  --thread-id <id>\` — worth fixing, goes to fix step
  \`bro debt set wontfix  --thread-id <id> --notes "<why>"\` — reject
  \`bro debt set duplicate --thread-id <id>\` — dupe of another row
Nothing proceeds to fix until every open row has a verdict. Debt rows are
evidence; a human owns the judgment call.
"""

[[steps]]
id = "fix"
title = "Fix claimed debt on a branch"
needs = ["triage"]
type = "agent"
description = """
For each \`claimed\` row: fix on a branch, commit, push, open ONE fix PR.
Mark rows as they land: \`bro debt set done --thread-id <id> --fix-pr {{fix_pr}}\`.
Threads on the *source* PRs are evidence — never resolve them; the fix PR is
the deliverable.
"""

[[steps]]
id = "pr-gate"
title = "GATE — bro act status on the fix PR"
needs = ["fix"]
type = "agent"
description = """
Determine the fix PR: use {{fix_pr}} if set, otherwise
\`gh pr list --state open --limit 1\` on the fix branch.
Run \`bro act status <pr>\` until exit 0: zero open review threads, no
pending CI, no pending SAST findings. Any blocker → fix and re-check.
Exit non-zero = the gate holds; do not merge around it.
"""

[[steps]]
id = "merge"
title = "HUMAN GATE — merge the fix PR"
needs = ["pr-gate"]
type = "human"
description = """
Gate is green — a human reviews and merges the fix PR. Merge is a human
decision; agents carry, humans ship.
"""

[[steps]]
id = "sync"
title = "bro debt sync — close the loop"
needs = ["merge"]
type = "agent"
description = """
After the fix PR merges: \`bro debt sync\`. Ledger statuses flow into beads —
done/wontfix rows close their beads, open ones stay in \`bd ready -l debt\`.
Idempotent; safe to re-run.
"""
`,
}
