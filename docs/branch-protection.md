# Branch protection: keeping review bots off occupied branches

Review bots with auto-fix (e.g. `kiloconnect[bot]` / Kilo Code Review) can push commits directly to PR branches, bypassing bro's occupancy plane and a live session's knowledge. bro's [foreign-push signal](../specs/bro-cqjd0.md) makes the bus tolerate and flag such pushes (the session is notified within one drive tick), but it cannot prevent them.

## Options

### 1) GitHub push ruleset (repo-enforced, blunt)

A push ruleset with `restrict_pushes` blocks all but an allow-list of actors from pushing to matching branches. This is enforceable by the repo itself, but it cannot be conditional on bro occupancy state (GitHub rulesets know nothing about bro's runtime). Applying it affects _all_ branches the ruleset matches.

Use this if you want to disable auto-fix pushes repo-wide.

Ready-to-run example (substitute the repo and actor IDs as appropriate):

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input '{
  "name": "no-review-bot-pushes",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [{
    "type": "restrict_pushes",
    "parameters": {
      "push_allowed_actor_ids": [<user/bot ids to allow>]
    }
  }]
}'
```

Notes:
- You must keep your own account, `dependabot[bot]`, and `github-actions[bot]` in the allow-list or you will break normal updates and release workflows.
- A wrong allow-list can lock you out; recovery is possible only through the ruleset UI.
- This is the blunt instrument — it disables the bots' auto-fix everywhere the ruleset applies.

### 2) Bot dashboard setting (per-integration)

Some review bots allow disabling auto-fix/pushes in their integration settings. If available, this is more targeted than a global push ruleset. Check the bot's dashboard/config for your GitHub installation.

## Recommendation

- If the goal is to prevent conflicts on branches that bro/agents actively occupy, a global push ruleset is the only thing the repo can enforce itself.
- Keep the foreign-push signal enabled (it is) so that even if pushes slip through or rules are not applied, the bus flags them to armed sessions.

## References

- Spec: [bro-cqjd0 — the bus says when a foreign push lands on your branch](../specs/bro-cqjd0.md)
- Implementation: `packages/cli/src/commands/foreign-push.ts`, integrated in `packages/cli/src/commands/drive.ts`
