# bro-l8c4f.4 — Prompt и обычный log не имеют owner-only permissions

## Problem

Every per-agent artifact under `<git-common>/bro/agents/` is created
umask-default — world-readable on a umask-022 machine:

- `commitSpawn` `mkdirSync(home, {recursive:true})` without a mode and
  `writeFileSync(promptFile, spec.prompt)` without one → `0644`.
- Native backend `openSync(log, 'a')` / `openSync(stderrLog, 'a')`
  without a mode → `0666 & ~umask` → `0644`.
- `.exit` lands via `printf > file` inside the wrapper shell — umask
  again, for all three shell-writing backends (native, tmux, docker).
- tmux/docker env files and the copilot task body pass
  `{mode: 0o600}` to `writeFileSync` — create-mode only; a pre-existing
  `0644` file keeps its mode through the truncate.

A prompt can embed secrets and review-thread context; `.log` is the
agent transcript; the env file is the ambient bag by design; gascity's
per-step `agent.toml` inlines caller env; the copilot `task.json` body
carries the prompt verbatim. On a shared machine every local user reads
them. The ACP event archive already pins `0600` (`acp-events.ts` —
create-mode plus a one-time repair chmod); the same rule must cover the
sibling artifacts. This is a conditional exposure, not an observed
leak — a host whose home dirs are already owner-only is safe today.

## Design

One private-artifact writer in `@broject/core` (`private-files.ts`),
exported alongside the other fs helpers:

- `writePrivateFileSync` / `appendPrivateFileSync` — `openSync` with
  create-mode `0600`, then `fchmodSync(fd, 0o600)` **before** the first
  byte lands: a legacy `0644` file is repaired *before* the write/append,
  never left readable with new content inside.
- `openPrivateAppendSync` — same fd contract for callers that keep the
  descriptor (native's spawn stdio).
- `mkdirPrivateSync` — `mkdirSync(recursive, mode: 0o700)`: the managed
  dir is pinned on creation; an **existing** dir keeps its mode (file
  modes carry the guarantee, and a shared-rig dir another user must
  also write into stays usable).
- `PRIVATE_FILE_MODE` / `PRIVATE_DIR_MODE` constants so call sites stop
  re-deriving the literal.

A `chmod`/`fchmod` failure warns on stderr and does not abort the
write — filesystems without POSIX modes (Windows, FAT mounts) must
still spawn. On Windows the calls map onto the read-only attribute; the
owner-only equivalent is the NTFS ACL on the user profile / repo dir —
`git-common` under a user profile is already owner-ACL'd, so no extra
code path runs there. POSIX is the only OS surface where the mode is
the enforcement.

Call sites:

- `commitSpawn` (covers every backend): `mkdirPrivateSync(home)`;
  `writePrivateFileSync(promptFile)`; `log` + `stderrLog` pre-created
  via `appendPrivateFileSync(f, '')` so every later append — the native
  inherited fd, tmux `tee -a` / `2>>`, docker `>>` / `2>>` — lands on a
  file already pinned.
- Native spawn: `openPrivateAppendSync` for log + stderr (repairs a
  mode drifted between the pre-create and the open).
- `.exit` stays wrapper-created — pre-creating an empty file would
  parse as exit `0` (`Number('') === 0` in `readExitFile`), a phantom
  clean exit. The wrapper `printf` runs under `( umask 077; … )`:
  subshell-scoped, so the worker's own umask — and the files it writes
  in the worktree — is untouched. Applied at all four sites (native
  argv, native template, tmux pane, docker wrapper).
- Env files (tmux ambient env, docker `--env-file`): swap the bare
  `{mode: 0o600}` for `writePrivateFileSync` — adds the repair the
  create-mode lacked.
- Copilot `task.json` (prompt verbatim) and gascity per-step
  `agent.toml` (caller env + pins): `writePrivateFileSync`; the
  per-step `agents/<step>` dir gets `mkdirPrivateSync`.
- `bro loop` work-order prompt (`writePrompt`): same writer — same
  artifact class, different directory.
- `serve.ts` `writeStateFile`: the hand-rolled `writeFileSync` +
  `chmodSync` pair swaps to the writer (identical semantics).
- `acp-events.ts`: adopts `PRIVATE_FILE_MODE`; the once-per-plane
  repair chmod stays — per-row cost must remain a Map lookup + queued
  socket write.

## Non-goals

- `bro/hooks/*.work` markers, the `agents.json` registry, daemon /
  provider / act-wait logs — operational metadata, not prompt/env
  content; unchanged.
- No fail-closed ownership check on the agents home (the bus socket's
  `assertPrivateDir` refuses a shared dir; artifacts keep writing on
  non-POSIX filesystems).
- No retro-fix sweep over historical artifacts — repair rides the next
  write/append, which is exactly when content re-enters them.

## Plan

- [x] `packages/core/src/private-files.ts` + `private-files.test.ts`
      (create-mode, repair-before-write on a `0644` file, append fd)
- [x] `agent-connectors.ts`: commitSpawn pre-create, native
      `openPrivateAppendSync`, `( umask 077; printf … )` wrappers, tmux /
      docker env files, copilot body, gascity step dir + `agent.toml`
- [x] `loop.ts` `writePrompt`, `serve.ts` `writeStateFile`,
      `acp-events.ts` constant
- [x] `agent-connectors.test.ts` contract test: per-backend `0600` on
      prompt/log/stderr/exit + `0644` repair across a respawn
- [ ] `npm run build`, `npm run typecheck`, `npm test` (exact CI
      commands)
