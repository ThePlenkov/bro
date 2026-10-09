# bro on Codex

In this chat, Codex commands own the session. Bro owns the durable plane.

| When | Codex | Bro |
| --- | --- | --- |
| A target that must survive turns | /goal | repo seed, hosts without /goal |
| Design before code | /plan | |
| Parallel work inside this chat | subagent, then /agent | a beads worker that must outlive the chat: bro agents |
| A background shell | /ps, then /stop | |
| Another approach, this chat kept | /fork or /side | a git worktree |
| The open PR | bro act | /review is the working tree |
