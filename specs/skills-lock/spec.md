---
parent: project
---

# skills-lock — materialising external skills through bro

## Problem

`bro setup --skills` installs bro's own skills from the embedded snapshot
(`skills-data.ts`). `bro setup --pack` installs a capability pack from an npm
package. Neither path brings an **external** skill — one owned by another repo —
into a consumer's `.agents/skills/`.

But the machine already runs that model: `skills-lock.json` in the bro repo
records skills owned by upstream repos (`codescene-oss/codescene-mcp-server`,
`typesafe-ai/skills`), materialised with
`npx skills add <owner>/<repo> --skill <name>`.

So the linking mechanism exists and is proven — but it lives **outside** bro. A
consumer of bro has no way to ask bro for the skills bro itself uses. The
lockfile is a dead file in bro: **no code reads it**.

## Only public sources

bro is a public repo. A skill locked from a **private** repo makes the lockfile
unusable for every contributor: `npx skills add <owner>/<private-repo>` cannot
resolve without credentials the contributor does not have, so `bro setup --lock`
fails for them over a skill they were never meant to install.

The lockfile therefore carries **public sources only**. A private skill stays in
the private repo it belongs to; it is not locked here, and bro does not try to
fetch it. bro's plugin ships what bro owns.

## Design

`bro setup` gains the ability to materialise the locked external skills.

**The lockfile is the contract.** `skills-lock.json` at the repo root:

```json
{
  "version": 1,
  "skills": {
    "<skill-name>": {
      "source": "<owner>/<repo>",
      "sourceType": "github",
      "skillPath": "<path inside the source repo>",
      "computedHash": "<sha256 of the source file>"
    }
  }
}
```

**Installation delegates to `npx skills`** — the same CLI that already produces
this lockfile. bro does not re-implement git fetching, hashing or symlinking:
`npx skills add <owner>/<repo> --skill <name> -y` per entry, then
`npx skills update` to refresh the whole set. bro's contribution is the
*contract* and the *verification*, not the mechanism.

**Verification is bro's own value-add.** After install, each locked skill is
checked against `computedHash` — the hash of the source file. A skill whose
content drifted from the locked hash is a **drift finding**, not a silent
update: the lock says "this is what I expected", and the installed copy says
something else. That is the failure a hash buys and a plain install does not.

**Fail-open, like every other probe.** No lockfile → nothing to install, no
error. No `npx` on PATH → the install is skipped with a line saying so; bro's
own skills still install. A missing upstream skill → that one is skipped, the
rest proceed. A hash mismatch → reported as drift, the skill stays installed
(the operator decides).

## What it does NOT do

- It does not **vendor** the skills into `bro/skills/` — they stay owned by
  their repos, and bro's plugin stays bro's own capability surface.
- It does not **publish** a bundle. The `compile → agents target → pack` path
  exists for a different job (shipping bro's own skills to consumers); this is
  the path for *consuming* skills bro does not own.
- It does not **decide** who owns a skill. When two repos ship the same skill
  name, the lockfile is the arbiter: one entry, one owner. That is a decision
  for the repo owner, and the lockfile records it.

## Commands

```bash
bro setup --skills          # bro's own skills (unchanged)
bro setup --lock             # materialise the locked external skills
bro setup --lock --dry-run   # report what would be installed and what drifted
bro setup --lock --check     # verify the installed copies against the lock
```

`--lock` is separate from `--skills` on purpose: installing bro's own skills is
always safe and fast; pulling from the network is a distinct, explicit act.

## Verification

- `bro setup --lock --dry-run` names every locked skill, its source, and
  whether the installed copy matches the locked hash.
- A drifted skill is reported with both hashes and the path where it differs.
- With no lockfile, no `npx`, or an unreachable upstream, the command degrades
  to a clear message and exit 0 — never a crash, never a partial install
  reported as complete.
- The installed tree matches what `npx skills` produces for the same lockfile
  (byte-identical for `codescene` today).

## Open

Whether the lockfile should be **read** or **written** by bro is the owner's
call. Reading it (this spec) makes bro a consumer of the skills contract.
Writing it — bro emitting `skills-lock.json` for skills bro ships — is the
mirror image and would make bro a publisher of the same format. Both are
compatible; doing both would let a bro repo and a skills repo exchange skills
without either owning the other's.
