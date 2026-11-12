---

name: msg
description: "Use when a message must reach ONE specific agent session — 'tell fixer-7 to ship it', 'ask claude:3f2a… for status'. `bro msg <session|role> <text>` resolves the target against the session ledger and delivers through the session inbox file (Tier-0 wake on that session's next hook, every mode) plus an events record. Roles: orchestrator; agentIds and sids resolve too. Requires `bro` (npx -y @broject/bro@0)."
---

# /msg (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

The fleet-addressed sibling of `bro comms notify`. `notify` drops a
mailbox event any session may drain; `msg` names a recipient — a
session key, sid, agentId, or the `orchestrator` role — resolved
against the machine-wide session ledger, and delivers two ways at
once:

- **Inbox file** — on hosts bro can prove (claude, codex, cursor,
  devin) the message lands in `inbox/<host>-<sid>` under the state
  dir. run.sh's Tier-0 `[ -s ]` check wakes Node on that session's
  next hook in EVERY mode — observe included — and the notify
  connector renders it as `[msg <kind> <from> → <host>:<sid>] …`.
- **Events record** — one `msg`-topic event through the events
  facade, exactly like notify: bus subscribers and the mailbox tail
  see it; on inbox-capable hosts the `to:` is the session key, a
  record the mailbox's own addressing can never double-deliver.

Everything else — unknown hosts, sessions the ledger has not seen,
`ended` rows — publishes through the mailbox vocabulary
(`to: <sid>`/`<agentId>`/`orchestrator`) so wired sessions still
receive it the notify way.

## Commands

| Command                                                  | What it does                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `bro msg <host>:<sid> <text>`                            | Message one session by its ledger key                             |
| `bro msg <sid> <text>`                                   | By sid — exact or unique prefix (≥4 chars)                        |
| `bro msg <agentId> <text>`                               | By the agent's registry id                                        |
| `bro msg orchestrator <text>`                            | The role — sessions with no agentId                               |
| `bro msg --kind ask --in-reply-to <ref> <target> <text>` | Typed/threaded — kind is a label, never a grant                   |
| `bro msg --key <k> <target> <text>`                      | Coalesce — a pending same-key drop from this source is superseded |
| `bro task give <session                                  | role> "title"`                                                    | Create + assign a bead, then message the session — the task twin |

## Policy

- **Name the session, not the crowd.** `msg` is for reaching a known
  recipient — a worker mid-task, the orchestrator, one sid. Broadcast
  stays `bro comms notify` (no `--to`) or `msg orchestrator`.
- **Ended sessions are reported, not delivered.** Their hooks never
  fire again; the command says so instead of pretending the inbox
  file will be read.
- **Ambiguity is an error, never a guess.** A sid prefix matching two
  sessions fails with the candidate list — re-send with `<host>:<sid>`.
- **Inbox entries carry no TTL.** A message to a live-but-idle
  session waits in the file until its next hook; nothing expires it.
  For anything that must not wait, the events record is the audit —
  but delivery itself is still hook-paced.
- **`bro task give` assigns, it does not claim.** The bead's
  `assignee` marks the fleet address; the recipient's own `bd
  --claim`/`bro work enter` is what binds the work.
