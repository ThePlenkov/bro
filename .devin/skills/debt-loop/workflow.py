import asyncio
import glob
import json
import os
import subprocess


def find_repo():
    """Locate the bro checkout: $BRO_DIR, cwd, then ~/repos/*."""
    candidates = [os.environ.get("BRO_DIR", ""), os.getcwd()]
    candidates += sorted(glob.glob(os.path.expanduser("~/repos/*")))
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, ".agents", "review-debt")) and \
           os.path.isfile(os.path.join(c, "packages", "cli", "dist", "index.js")):
            return os.path.abspath(c)
    raise RuntimeError("bro checkout not found (set BRO_DIR)")

REPO_DIR = find_repo()
REPO = "github.com/ThePlenkov/bro"
HARVEST_DIR = os.path.join(REPO_DIR, ".agents", "review-debt", "harvests")
WORKTREES = os.path.join(os.path.dirname(REPO_DIR), os.path.basename(REPO_DIR) + "-worktrees")

META = {
    "name": "debt-loop",
    "description": "Work open review-debt rows: grouped shared-VM fix agents open PRs, one land agent merges them via bro merge",
    "product": "ThePlenkov/bro",
    "soft_time_limit_minutes": 45,
    "phases": [
        {"title": "fix", "detail": "Fix grouped debt findings, verify, open a PR per group"},
        {"title": "triage", "detail": "Verdicts for stale PRs (read-only)"},
        {"title": "land", "detail": "bro merge each opened PR, serially; mark ledger rows done"},
    ],
}

FIX_SCHEMA = {
    "type": "object",
    "properties": {
        "branch": {"type": "string"},
        "pr_url": {"type": "string"},
        "fixed_ids": {"type": "array", "items": {"type": "string"}},
        "skipped_ids": {"type": "array", "items": {"type": "string"}},
        "verification": {"type": "string"},
        "notes": {"type": "string"},
    },
    "required": ["pr_url", "fixed_ids", "skipped_ids", "verification", "notes"],
}

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "pr": {"type": "integer"},
                    "action": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["pr", "action", "reason"],
            },
        }
    },
    "required": ["verdicts"],
}

LAND_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "pr_url": {"type": "string"},
                    "status": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["pr_url", "status"],
            },
        }
    },
    "required": ["results"],
}


def load_rows():
    rows = []
    for path in sorted(glob.glob(os.path.join(HARVEST_DIR, "*.jsonl"))):
        for line in open(path):
            line = line.strip()
            if line and json.loads(line).get("status") == "open":
                rows.append(json.loads(line))
    # dedupe by thread_id
    seen, out = set(), []
    for r in rows:
        if r["thread_id"] not in seen:
            seen.add(r["thread_id"])
            out.append(r)
    return out


def fmt_rows(rows):
    out = []
    for r in rows:
        body = (r.get("body") or r.get("body_preview") or "")[:1800]
        loc = f"{r.get('path') or ''}:{r.get('line') or ''}"
        out.append(
            f"- thread_id: {r['thread_id']}\n"
            f"  thread_url: {r.get('thread_url', '')}\n"
            f"  location: {loc}\n"
            f"  body:\n{body}"
        )
    return "\n".join(out)


FIX_COMMON = f"""
Repo: {REPO}, already cloned at {REPO_DIR} on THIS machine (shared VM — do not
clone). You are a fixer agent closing collected review debt.

Create your own worktree FIRST (other agents work in sibling worktrees — never
touch {REPO_DIR} itself or their dirs):
  cd {REPO_DIR} && git fetch origin
  git worktree add {WORKTREES}/debt-{{slug}} -b devin/debt-{{slug}} origin/main
Do ALL work inside {WORKTREES}/debt-{{slug}} on branch devin/debt-{{slug}}.
The repo uses npm workspaces — `npm ci` once inside the worktree before
building/testing. `bd` and `gh` are on PATH via brew
(/home/linuxbrew/.linuxbrew/bin — prepend it to PATH if needed).

For EACH assigned finding: open the thread_url (use `gh api` to read the full
review comment), decide the correct fix in the CURRENT code on the default
branch (the finding was harvested from a merged PR — the code may have moved),
apply it, and reply/resolve nothing (the source PR is merged).

Rules:
- Follow AGENTS.md conventions. Minimal, focused edits; fix the code shape, not
  just the symptom. Data-driven constructs over if-chains.
- Local verification before pushing: `cd site && npm run typecheck` for
  site/src; `npm run check:codescene` after touching files it gates (fix what
  it flags, do NOT iterate via push->CI); unit tests for changed packages.
- Never merge anything yourself. Push your branch and open ONE pull request
  for the whole group with `gh pr create` (conventional-commit title), report
  its URL.
- If a finding is already fixed or a false positive in current code, put its
  thread_id in skipped_ids with the reason in notes.

Structured output: branch, pr_url, fixed_ids[], skipped_ids[], verification
(commands + result), notes.
"""


def build_groups(rows):
    """Group rows into (slug, prompt) fix groups + the stale triage set."""
    site = [r for r in rows if r["area"].startswith("site/")]
    infra = [r for r in rows if r.get("source", "threads") == "threads" and not r["area"].startswith("site/")]
    codeql = [r for r in rows if r.get("source") == "code-scanning"]
    dependabot = [r for r in rows if r.get("source") == "dependabot"]
    stale = [r for r in rows if r.get("source") == "stale-prs"]

    groups = {}
    if site:
        groups["site"] = (
            FIX_COMMON.replace("{slug}", "site")
            + f"\nFindings ({len(site)}) — site/src/routes/backlog.tsx and nearby site files:\n"
            + fmt_rows(site)
        )
    if infra:
        groups["infra"] = (
            FIX_COMMON.replace("{slug}", "infra")
            + f"\nFindings ({len(infra)}) — scripts/ and packages/cli paths:\n"
            + fmt_rows(infra)
        )
    if codeql:
        groups["security"] = (
            FIX_COMMON.replace("{slug}", "security")
            + f"\nFindings ({len(codeql)}) — CodeQL alerts; fix the pattern, not the alert:\n"
            + fmt_rows(codeql)
            + "\nInspect each alert's data flow end to end; if user input truly reaches exec/log output, sanitize at the boundary."
        )
    if dependabot:
        groups["deps"] = (
            f"""
Repo: {REPO}, cloned at {REPO_DIR} on THIS machine (shared VM). Dependency fixer.
Work ONLY inside your own worktree:
  cd {REPO_DIR} && git fetch origin
  git worktree add {WORKTREES}/debt-deps -b devin/debt-deps origin/main
  cd {WORKTREES}/debt-deps && npm ci

Close these Dependabot alerts:
"""
            + fmt_rows(dependabot)
            + """
Method: `npm update <pkg>` / targeted version bumps (critical+high first) —
whatever resolves each alert without breaking the build. `npm run build` +
test suite; keep lockfile changes minimal. Push the branch, open ONE pull
request via `gh pr create`, report pr_url and fixed alert ids.
Structured output: branch, pr_url, fixed_ids[] (dependabot:N), skipped_ids[],
verification, notes.
"""
        )
    return groups, stale


async def main():
    await register_workflow(META)
    rows = load_rows()
    groups, stale = build_groups(rows)
    log(f"open debt rows: {len(rows)} across {len(groups)} fix groups + {len(stale)} stale")

    async def fix(slug):
        try:
            return await agent(groups[slug], phase="fix", schema=FIX_SCHEMA,
                               label=f"fix-{slug}", mode="lite", vm_mode="shared")
        except WorkflowAgentError as e:
            log(f"fix-{slug} failed: {e}")
            return None

    thunks = [(lambda s=s: fix(s)) for s in groups]
    if stale:
        thunks.append(lambda: agent(
            f"""Repo: {REPO} (checkout at {REPO_DIR}). Read-only triage of these
stale PRs — do NOT modify anything (no commits, closes, comments). Verdict per
PR in {{"close","rebase-and-fix","keep","needs-owner"}} + one-line reason:
""" + fmt_rows(stale) + """
Check each PR's state, checks, conflicts, and whether main already absorbed its
intent. Structured output: verdicts[].""",
            phase="triage", schema=TRIAGE_SCHEMA, label="triage-stale",
            mode="lite", vm_mode="shared"))

    results = await parallel(thunks)
    fix_results = [r for r in results[: len(groups)] if r]
    triage = results[-1] if stale else None

    prs = [(r["pr_url"], r["fixed_ids"]) for r in fix_results if r.get("pr_url")]
    for r in fix_results:
        log(f"fix done: {r['pr_url']} fixed={len(r['fixed_ids'])} skipped={len(r['skipped_ids'])}")
    if triage:
        log("stale verdicts: " + json.dumps(triage["verdicts"]))

    if not prs:
        log("no PRs opened — nothing to land")
        return

    land = await agent(
        f"""Repo: {REPO}, checkout at {REPO_DIR} (shared VM; sibling worktrees
under {WORKTREES}/ belong to the fixers — use the matching one when pushing a
fix onto a PR branch). Land each PR through the FULL merge cycle, serially:
""" + "\n".join(f"- {u} (mark these debt rows done on merge: {','.join(ids)})" for u, ids in prs) + f"""

For each PR:
1. `npm run build` once in {REPO_DIR}, then `node packages/cli/dist/index.js merge <PR-number>`
   (the `bro merge` command; `gh pr ready` first if the PR is a draft).
2. bro merge enforces the gate: all review threads resolved AND CI green, then
   auto-merge. Never `gh pr merge` manually. If the gate reports open threads
   or red CI, fix them on that PR's branch first (reply + fix + resolve),
   then re-run.
3. Merge conflict: rebase the branch onto main, resolve, push, re-run.
4. After a PR merges, mark its debt rows done:
   `node packages/cli/dist/index.js review debt set done --thread-id <ids>`
   then `node packages/cli/dist/index.js review debt sync`.
5. Record per-PR status: merged | blocked(reason) | failed(reason).
Stop and report rather than skipping steps. Structured output: results[].""",
        phase="land", schema=LAND_SCHEMA, label="land-all",
        mode="lite", vm_mode="shared", soft_time_limit_minutes=60,
    )
    log("land: " + json.dumps(land["results"]))


asyncio.run(main())
