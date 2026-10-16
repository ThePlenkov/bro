# bro-hc1oy — dogfood scenarios speak only `npx bro`

## Problem

The dogfood runbooks are the out-of-the-box proof: a consumer who
installs bro gets the whole workflow through one binary. Today the
scenarios type `bd create`, `bd update`, `git push`, `gh pr create`,
and the claude-plugin scenario provisions a 50-line bash apiKeyHelper
doing `git`/`curl`/`jq`/`setsid` plumbing by hand. User ruling: every
literal command in a dogfood scenario is `npx bro …` — no other CLIs.

## Surface gaps closed here

1. **`bro task` already exists** — the builtin `task` doc-type exposes
   `bro task new "title"`, `bro task set <id> --description=…`,
   `bro task show|list|close|rm` over the connectors-aware
   `facade('tasks')` store, so the runbook never names `bd`. A first
   draft of this bead added a duplicate `task` *plugin* — review caught
   that plugin dispatch shadows the doc-type (and bare `taskStore()`
   ignores `connectors.tasks`), so the runbook just uses the existing
   doc verbs; `desc` spells as `set --description=…`.
2. **`bro serve ensure --port <n>`** — the repo-bound lazy start +
   credential, replacing the bash helper:
   - probe `GET 127.0.0.1:<port>/api/v1/health`
   - healthy and `.dir` equals this repo's realpath → print the token
     from this repo's `serve.json`
   - healthy but a foreign `.dir` → stderr + exit 1 (serialize
     same-port runs; never hand out a token the listener rejects)
   - dead port → spawn this same CLI detached (`process.execPath`
     + `argv[1]` + `serve --port`), append to
     `<git-common>/bro/serve.log`, poll health (~20s), then print the
     token. Stdout never emits an empty key; failures are stderr +
     nonzero.
   - env passes through: the client's settings env (e.g.
     `BRO_PROVIDER_BACKEND`) flows claude → apiKeyHelper → spawned
     serve, so the conductor wires itself.

## Scenario rewrites

- `claude-plugin.md` and `core-workflow.md`: every runnable literal is
  `npx bro <cmd>`. Commit stays prose ("commit it") — the runner's own
  tool use is not runbook surface. The remote follow-up is described
  without spelling foreign CLIs ("push the branch, open the PR, then
  `npx bro review act wait`").
- `claude-plugin.files/.claude/settings.local.json`: apiKeyHelper is
  `npx --no-install bro serve ensure --port 44928` (`--no-install`
  pins the installed build — the dogfood tests OUR binary, not a
  registry fetch); env gains `BRO_PROVIDER_BACKEND=devin-acp-max` so
  the ensured serve wires the acp conductor.
- `dogfood-keyHelper.sh` is deleted — the helper is now one line.

## Assert

- `bro task` new/desc round-trips the `spec:` link (fake-bd tests).
- `serve ensure`: live-this-repo prints the token; live-foreign exits
  nonzero; dead port spawns and eventually prints a token.
- Neither runbook names `bd`, `curl`, `jq`, `gh`, or literal `git`.
