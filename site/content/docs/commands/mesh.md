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
`inbox`/`claim`/`done`/`accept`/`reject`. `bro mesh wait` performs a
point-check and returns; it does not block until a dependency resolves.
For blocking waits on external dependencies use
`bro wait external:<rig>:<id>`. Use `bro mesh peers add <alias> <mesh://<org>/<repo>> <remote> [--login L]`
and `bro mesh peers remove <alias>` to manage peer bindings.

| Command                                                 | What it does                        |
| ------------------------------------------------------- | ----------------------------------- |
| `bro mesh me`                                           | Show this rig's identity            |
| `bro mesh peers`                                        | List configured peers               |
| `bro mesh peers add <alias> <rig> <remote> [--login L]` | Bind a peer rig                     |
| `bro mesh peers remove <alias>`                         | Drop a peer binding                 |
| `bro mesh pull`                                         | Sync from peers                     |
| `bro mesh inbox`                                        | Show incoming requests              |
| `bro mesh request <mesh://<org>/<repo>> <title>`        | Post a request to a peer            |
| `bro mesh claim <id>`                                   | Claim an inbox item                 |
| `bro mesh done <id>`                                    | Mark claimed work done              |
| `bro mesh accept <id>`                                  | Accept delivered work               |
| `bro mesh reject <id>`                                  | Reject delivered work               |
| `bro mesh wait <id>`                                    | Point-check a thread (not blocking) |

See [mesh spec](https://github.com/ThePlenkov/bro/blob/main/specs/mesh/spec.md) for the protocol.
