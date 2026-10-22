# bro-l8c4f.4 — owner-only (0600) agent prompts and logs

Child of the principal audit bro-l8c4f (private-artifacts slice). Parent
audit: analysis only — this spec is the implementation design.

## Problem

`<git-common>/bro/agents/` holds each spawned worker's rendered prompt
(`<agentId>.prompt.md`), its agent-updates log (`<agentId>.log`) and the
stderr capture beside it (`<agentId>.stderr`). Every creation point
inherited the umask: `writeFileSync(promptFile, spec.prompt)` and
`openSync(log, 'a')` pass no `mode`, so under a 022 umask the new files
land 0644 — content readable by every local account — while the same
directory's env files and the raw ACP archive are already pinned 0600
(`writeFileSync(envFile, …, { mode: 0o600 })` in the tmux/docker
connectors, `appendFileSync(…, { mode: 0o600 })` + `chmodSync` in
`packages/providers/src/acp-events.ts`).

Scope of this claim is file mode only. It does **not** assert a leak on
a machine whose home directory is closed to other users.

## Design

One local helper in `packages/cli/src/agent-connectors.ts`:

```ts
function writePrivate(path: string, data: string, append = false): void {
  if (existsSync(path)) chmodSync(path, 0o600)   // repair FIRST
  writeFileSync(path, data, { mode: 0o600, flag: append ? 'a' : 'w' })
}
```

Order is the contract: a `mode` flag only pins a NEW file, so the
repair of a pre-existing 0644 file runs **before** any byte of the
write lands in it; for a new file the umask can only clear bits, so
`0o600` survives any umask. `append` never truncates — it exists for
files a shell or fd opens with `>>` afterwards.

Call sites, all in `packages/cli/src/agent-connectors.ts`:

- `commitSpawn` — the prompt. Single funnel every backend (native,
  tmux, gascity, docker, copilot) and every worker kind (template,
  `argv` → `bro acp-worker`) already writes through, so one site covers
  the native, template and ACP spawn pathways.
- native spawn — `log`/`stderrLog` pre-created just before the append
  fds open; `openSync(log, 'a')` on an existing 0600 file keeps the
  mode, and the `logFrom`/`stderrFrom` byte offsets are unaffected
  (creation adds zero bytes, `append` never truncates).
- tmux spawn — pre-created before the pane's `tee -a` and `2>>`, which
  would otherwise create both files with the shell's umask.
- docker spawn — pre-created before the container's `>>`/`2>>` on the
  mounted host paths. `dockerRunArgv` already defaults `--user` to the
  host uid, so the worker is the file owner and can still read the
  prompt and append its log.
- `mkdirSync(home, { recursive: true, mode: 0o700 })` in `commitSpawn`
  — a NEW `<common>/bro/agents` is owner-only (mode applies to every
  level the recursive call creates). An existing directory keeps the
  mode it was created with: no retroactive chmod of a tree the diff
  does not own, and with 0600 files inside a legacy 0755 dir the
  contents stay unreadable either way.

`stderr` is the log's sibling capture and follows the same rule — same
directory, same writer, same exposure class.

### Non-goals

- `.exit` — a one-byte return code written by the worker's own shell
  right after `commitSpawn` unlinks it; not prompt/log content, and
  pre-creating it would put an empty file where the harvest ladder
  reads a completed run. `env` files are already 0600.
- `<git-common>/bro/loop/` — loop run logs and loop work-order prompts
  live in a different directory and were not part of this bead's
  evidence; the parent audit tracks them.
- Retroactive repair of files bro does not write again: an old 0644
  artifact is fixed the next time bro writes/appends it, per the
  acceptance ("до записи/append"), not by a one-shot chmod sweep.
- GasCity/copilot: neither writes a local `<id>.log` (copilot's
  registry row names the remote session URL; GasCity's session logs
  live in its own config dir), so there is no local file to pin there.

### Windows

`writeFileSync(mode)`/`chmodSync` shape only the read-only bit on
Windows — NTFS ACLs are the equivalent, and a file under the user's
profile inherits a user-only ACL from the profile directory. bro
documents that equivalent; it does not author ACLs.

## Verify

- `packages/cli/src/agent-connectors.test.ts` — the connector contract
  (native, tmux, docker), with `process.umask(0o022)` pinned for the
  duration of the spawn:
  - new prompt/log/stderr all satisfy `mode & 0o777 === 0o600`, and a
    freshly created `<common>/bro/agents` is 0700;
  - after a first run's prompt/log/stderr are chmod'd to 0644, a
    respawn (same agentId, log appended) leaves all three 0600 again.
- ACP pathway: `packages/providers/src/acp-events.test.ts` asserts the
  raw ACP archive stays 0600 (the audit's contrast — regression guard),
  and the `argv` worker spawn test asserts the prompt file the ACP
  worker execs is 0600.
- Commands: `npx tsc --noEmit`, then from `packages/cli`
  `XDG_CONFIG_HOME=/tmp/opencode/empty-config npx tsx --test
  src/agent-connectors.test.ts` and from `packages/providers`
  `npx tsx --test src/acp-events.test.ts`.
