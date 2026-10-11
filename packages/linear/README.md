# @broject/linear

[![npm](https://img.shields.io/npm/v/@broject/linear)](https://www.npmjs.com/package/@broject/linear)

The Linear connector for `bro` — Linear issues as a `tasks` backend
(`TaskStore`/`TaskStoreAsync`) plus a `queries` facade so `bro query`
plans can fan out to Linear's GraphQL API next to github/gitlab/atlassian.

> You probably want the CLI instead — `bro` ships this connector already.
> Install this only when writing a tasks backend for another tracker.

## Install

```bash
npm i @broject/linear
```

Requires Node ≥ 22 and `curl` on PATH for the sync task surface. ESM only.

## Configuration

- `LINEAR_API_KEY` — a personal API key (Linear → Settings → Security &
  access). Sent verbatim in the `Authorization` header; never logged.
- `LINEAR_TEAM` — the team key (`ENG`) or UUID this repo's issues live
  in. Optional when the key's workspace has exactly one team; required
  otherwise (the error lists the visible keys).
- `connectors.tasks = "linear"` in `bro.config.json` selects it as the
  task backend — name-only opt-in, a git remote can never auto-select it.
- Query plans: `provider = "linear"` on a step, or a
  `connectors.queries = "linear"` pin.

```jsonc
// bro.config.json
{ "connectors": { "tasks": "linear" } }
```

```toml
# plan.toml — merged JSON fan-out across providers
kind = "query"
[[step]]
id = "linear-queue"
provider = "linear"
doc = """
query { team(id: "ENG") { issues(first: 5, filter: { state: { type: { nin: ["completed","canceled"] } } }) { nodes { identifier title } } } }
"""
```

## Mapping

| bro            | Linear                                                        |
| -------------- | ------------------------------------------------------------- |
| `id`           | identifier `ENG-123` (bare `123`, URLs and UUIDs resolve too)   |
| `open`         | backlog/unstarted, no assignee, unblocked                       |
| `in_progress`  | started state, or any assignee                                  |
| `blocked`      | triage, open `blocks` blocker, open sub-issue, `blocked` label  |
| `closed`       | completed/canceled/archived                                   |
| `claim`        | assign the API key's `viewer` (read → assign → verify)          |
| `deps`         | `blocks` relations — `inverseRelations` up, `relations` down    |
| `children`     | sub-issues                                                    |
| `priority`     | native priority name-mapped (urgent→0 … none→4)                 |
| metadata       | `<!-- bro: {...} -->` trailer — last element of the description   |

## Links

- Docs: <https://broject.dev/docs/integrations>
- Source: <https://github.com/ThePlenkov/bro/tree/main/packages/linear>
- CLI: <https://www.npmjs.com/package/@broject/bro>
