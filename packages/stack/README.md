# @broject/stack

Stacked bead → worktree → PR chains for `bro` — a gh-stack analogue over
the `stack/<name>/<n>-<slug>` branch namespace and the `.git/bro/stack/`
edge files `bro work enter` already records. Pure domain logic (branch
parsing, member ordering, sync planning); all git/host IO lives in the
CLI (`packages/cli/src/commands/stack.ts`).

```text
bro stack push <bead> --name <stack>   # worktree on the stack tip
bro stack list [<name>]                # the chain: bead, branch, PR, state
bro stack sync [<name>]                # retarget/rebase after a merge
bro loop --stack <name>                # drive the chain autonomously
```
