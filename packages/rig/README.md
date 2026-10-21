# @broject/rig

The bro lifecycle engine as a library — one state machine per work item
(spec `bro-oy3k1.1`), re-entered through a single verb:

```ts
import { rigNext } from '@broject/rig'

const verdict = rigNext(dir, item) // → step | gate | wait | done | blocked
```

`rigNext` recomputes from durable state on every call — beads claims,
the git-common agent registry, worktrees, the forge. Idempotent,
stateless, never waits, never writes: any signal or timer re-enters the
same probe and races resolve on the next call.

Also exported: `rigFocus` (the no-arg item resolution), the ready-set
read (`readyBeads`, `ReadyBead`, `NEVER_CLAIM_LABELS`, `storeFor`) the
verdict's dep-gate stands on.

The CLI (`bro rig next`) is a thin adapter over this package — argv,
stdout, exit code live in `packages/cli`; the engine never imports the
cli composition root and never calls `process.exit`.
