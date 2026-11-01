# Branch protection: keeping review bots off occupied branches

Review bots with auto-fix (e.g. `kiloconnect[bot]` / Kilo Code Review) can push commits directly to PR branches, bypassing bro's occupancy plane and a live session's knowledge. bro's [foreign-push signal](../specs/bro-cqjd0.md) makes the bus tolerate and flag such pushes (the session is notified within one drive tick when the event publish succeeds; a failed publish is not retried), but it cannot prevent them.

## Options

### 1) GitHub push ruleset (repo-enforced, blunt)

A push ruleset with `restrict_pushes` blocks all but an allow-list of actors from pushing to matching branches. This is enforceable by the repo itself, but it cannot be conditional on bro occupancy state (GitHub rulesets know nothing about bro's runtime). Applying it affects _all_ branches the ruleset matches.

Use this if you want to disable auto-fix pushes repo-wide.

Ready-to-run example (substitute the repo and actor numeric IDs as appropriate):

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input - <<'JSON'
{
  "name": "no-review-bot-pushes",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [
    {
      "type": "update",
      "parameters": {
        "update_allows_fetch_and_merge": true
      }
    }
  ],
  "bypass_actors": [
    { "actor_id": <your_numeric_user_id>, "actor_type": "User", "bypass_mode": "always" },
    { "actor_id": <dependabot_numeric_id>, "actor_type": "Integration", "bypass_mode": "always" },
    { "actor_id": <github_actions_numeric_id>, "actor_type": "Integration", "bypass_mode": "always" }
  ]
}
JSON
```

Notes:
- Use **numeric GitHub database IDs** for actors (not login names like `"dependabot[bot]"`). Look them up with `gh api users/<login> --jq .id` (e.g., `gh api users/dependabot[bot] --jq .id`, `gh api users/github-actions[bot] --jq .id`). For your own account, use `gh api user --jq .id`.
- You must keep your own account, `dependabot[bot]`, and `github-actions[bot]` in `bypass_actors` or you will break normal updates and release workflows.
- A wrong bypass list can lock you out of pushes. Recover by editing or deleting the ruleset in the UI, or through the REST API (for example `gh api -X DELETE repos/<owner>/<repo>/rulesets/<ruleset_id>`).
- This is the blunt instrument — it disables the bots' auto-fix everywhere the ruleset applies.

### 2) Bot dashboard setting (per-integration)

Some review bots allow disabling auto-fix/pushes in their integration settings. If available, this is more targeted than a global push ruleset. Check the bot's dashboard/config for your GitHub installation.

## Recommendation

- If the goal is to prevent conflicts on branches that bro/agents actively occupy, a global push ruleset is the only thing the repo can enforce itself.
- Keep the foreign-push signal enabled (it is) so that even if pushes slip through or rules are not applied, the bus flags them to armed sessions.

## References

- Spec: [bro-cqjd0 — the bus says when a foreign push lands on your branch](../specs/bro-cqjd0.md)
- Implementation: `packages/cli/src/commands/foreign-push.ts`, integrated in `packages/cli/src/commands/drive.ts`
