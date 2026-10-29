---

title: bro mesh
description: Inter-rig work federation across bro checkouts.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro mesh` coordinates work between bro rigs. Peer bindings can point to
local checkouts or beads-remote Dolt replicas; requests flow through
`inbox`/`claim`/`done`/`accept`/`reject`, with `wait` for blocking on
dependencies.

| Command                           | What it does                  |
| --------------------------------- | ----------------------------- |
| `bro mesh me`                     | Show this rig's identity      |
| `bro mesh peers`                  | List configured peers         |
| `bro mesh pull`                   | Sync from peers               |
| `bro mesh inbox`                  | Show incoming requests        |
| `bro mesh request <repo> <title>` | Post a request to a peer/repo |
| `bro mesh claim <id>`             | Claim an inbox item           |
| `bro mesh done <id>`              | Mark claimed work done        |
| `bro mesh accept <id>`            | Accept delivered work         |
| `bro mesh reject <id>`            | Reject delivered work         |
| `bro mesh wait <id>`              | Wait for a request to resolve |

See [mesh spec](https://github.com/ThePlenkov/bro/blob/main/specs/mesh/spec.md) for the protocol.
