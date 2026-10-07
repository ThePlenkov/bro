# bro-kim1e — cross-repo REMOTE phase: github-issue transport, wasteland board

## Problem

`bro request` (LOCAL) and `bro wait external:<ref>` (WAIT) both
assume the far side is a **beads store bro can name**. LOCAL resolves
a same-machine checkout and drops the envelope bead into it; WAIT
resolves `external:<project>:<capability>` against a foreign store and
reads bd's own `provides:<capability>` ship predicate. Both fall over
on the case the mesh spec names for the `github` transport row —
*repos without federation access* — and neither has a plane for the
public-rig case the `wasteland` row names.

The failure mode today is the pre-mesh one: a session with a finding
that belongs to a repo it cannot check out has three bad options
(patch it, hand-create a bead somewhere it does not own, drop it). It
patches or drops, and the request protocol silently does not apply.

Two shapes are missing, and they are not the same problem:

- **github** — a *directed* request to one rig that has a public repo
  but no federation surface (no dolt remote, no beads store). The
  delivery channel already exists: issues and comments are
  authenticated, versioned, and readable by anyone.
- **wasteland** — an *open* board where any rig may claim any item.
  There is no addressee; there is a queue and a registry.

## Design

### Two transports, one envelope, no new lifecycle

mesh/1 is unchanged. `github` and `wasteland` are **transport
bindings** under the existing seam (specs/mesh Transports), not new
kinds and not new verbs: the same `request → claim → result →
accept/reject` reduction in `thread.ts` reads both planes. A request
posted over github and one posted over wasteland are the same record
to every other layer.

### The github plane — the issue body carries the envelope

**Delivery.** `POST /repos/{owner}/{repo}/issues` with a
machine-readable envelope in the body. `validateEnvelope` /
`toEnvelope` already exist for exactly this shape ("transports that
carry the envelope as a document — github-issue bodies, wasteland
payloads", `packages/mesh/src/envelope.ts`).

The body is human-rendered and the envelope is fenced and marked, so a
maintainer can read the issue and a session can parse it:

````text
bro: request from mesh://theplenkov/bro — do not edit the block below

```json
{ "v": "mesh/1", "id": "req-7f2a", … }
```

<!-- mesh/1 request req-7f2a — end of machine block -->
````

**Parsing is tolerant, by necessity.** The body is a shared editable
document: humans edit above the fence, GitHub appends checklists and
cross-references below it, and bots inject footers. The read never
anchors on line offsets or on "the body is only the envelope". It
takes the **last** fenced ` ```json ` block that satisfies
`validateEnvelope`, and an issue with no such block is not a mesh
record at all (surfaced as an error line, never as a parsed request).
This is the same discipline the beads inbox applies by refusing to
hand-labelled rows (`envelopeFromBead`).

**Labels are a query index, never the record.** Two hard GitHub facts,
both verified against the API on this account:

- Label names cap at **50 characters** (`422 … name is too long
  (maximum is 50 characters)`). The mesh ref/evidence label scheme
  does not fit: `mesh:ref:url:https://github.com/org/repo/pull/1` is
  53, and even `mesh:to:mesh://<long-org>/<long-repo>` crosses 50.
- `gh issue create --label` and `gh issue edit --add-label` **fail**
  when a label does not already exist (`could not add label: 'X' not
  found`), while the REST `labels[]` parameter **creates** missing
  labels silently.

So: the body is the single source of truth, and only routing labels
ride the issue, only when they fit in 50 characters. A label that
would overflow is dropped, not truncated — a truncated `mesh:to:` is a
different string that matches nothing, and a silently wrong routing
label is worse than no label. Nothing in the read path parses a label
to learn an envelope field; labels exist so `gh issue list --search
'label:mesh:kind:request'` can narrow a repo without fetching every
body.

**The REST path, deliberately.** Delivery uses the API's `labels[]`
rather than `gh issue create --label`, because the API creates the
mesh labels on first use. A rig whose repo has never carried a mesh
issue — the normal case for a new plane — would otherwise fail its
first delivery on a missing label and every delivery after it.

**Provenance is the authenticated author.** The mesh Trust rule
("provenance is the transport, not the envelope") maps onto GitHub
exactly: the authenticated `author` of the issue or comment *is* the
transport. A `claim`/`result`/`accept` comment is admitted to the
thread reduction only when its author matches the login the peer
binding expects; a mismatch is flagged exactly like the beads
`mismatch` case, never trusted and never silently dropped. This is
strictly stronger than the beads plane, where provenance is the
binding a replica arrived over.

**Reads need nothing but pull access.** A requester with no checkout
reads the far rig's requests through `gh issue list -R <owner>/<repo>`
(read permission is `pull:true`). Writing does not need push: an
authenticated account can comment on an issue in a repo it has no
association with — verified on a repo where this account holds only
`pull` (`author_association: "NONE"` on the created comment). That is
the sovereignty story for this plane — the requester writes as *its own
account*, into a public thread, and never mutates a foreign store.
Opening an issue is assumed to behave the same way, but that half is
**not verified** — posting a test issue to a stranger's repo is not a
price worth paying for a design detail, and a `403` on either verb is
an ordinary error line rather than a reason to retry with different
credentials. The e2e below settles it in a rig the team controls.

### The github plane does **not** wire an `external:` dep

This is the sharp edge, and it is the reason this plane needs its own
waiter rather than reusing WAIT's.

`bd dep add <bead> external:<project>:<capability>` is inert on bd
1.3.1 for this target, for two independent reasons, both verified
against the installed `bd` (1.3.1) rather than assumed:

1. **No query-time resolution in 1.3.1.** An issue with an unshipped
   external capability stays in `bd ready` and absent from `bd blocked`
   — verified in a clean store: `bd dep add v1-6ac
   external:someproject:somecap` then `bd ready` still lists the issue
   as ready. The `externaldeps` resolver/decorator package does not
   exist at tag `v1.3.1` (nor at `v1.3.2-rc.1`); it is on `main` only,
   and its design doc states the pre-fix problem plainly: the omission
   "makes an unsatisfied external blocker invisible to ready-work
   queries". `bd ship` and `provides:` exist in 1.3.1, but nothing
   consumes them.
2. **A GitHub issue is not a beads store.** Even with the decorator
   present, resolution goes `external_projects[name] → path →
   openProject(<path>/.beads)` and reads `provides:<capability>` off a
   local issue. An issue on github.com has no store at that path, so
   the ref could never resolve.

A `mesh://` rig URI makes it worse, and this is worth stating because
`wireDep` writes the URI verbatim today (`mesh: post.ts`): bd splits
the reference with `strings.SplitN(raw, ":", 3)`, so
`external:mesh://theplenkov/bro:bro-kim1e` parses as project=`mesh`,
capability=`//theplenkov/bro:bro-kim1e`. The format check passes
(both halves non-empty) and the edge is stored, pointing at a project
named `mesh`. Any `external:` ref carrying a rig URI is mis-parsed by
bd into a project name that will never be configured.

So the github plane posts a **mirror bead into the requester's own
store** — the own-store post `postEnvelope` already performs for
beads-remote, and the same one `bro mesh request` does today — and
the *thread* is the read. The mirror is what bd tracks locally; the
issue is what is read remotely. The foreign surface is never wired
into the local dep graph, which is also what keeps the requester from
inheriting a dep whose resolution rule does not exist.

The consequence for the phase map: WAIT's `bro wait external:<ref>`
answers the beads-plane question and is explicitly *not* this plane's
waiter. The github plane's waiter is a thread read over issues — the
`bro mesh wait` reduction, extended with comment envelopes as a
record source. WAIT's spec already names this as out of scope ("a
GitHub-issue / wasteland plane — phase REMOTE", `bro-y5zcw`).

### The wasteland plane — the board is the queue, posting is a fork

Wasteland's model is deliberately not the request model: a shared
commons database (`wl-commons`) holding a `wanted` board, a `rigs`
registry, and `completions`. A rig **joins by forking** the commons
into its own DoltHub org and registering itself; in the default PR
mode, mutations go to `wl/<rig-handle>/<wanted-id>` branches on the
rig's own fork and reach upstream only through a proposed PR.

That is the mesh sovereignty rule in a foreign key: **a wasteland rig
never writes the upstream board.** It writes its fork and proposes.
So the transport is genuinely pull-shaped and needs no sovereignty
argument of its own — it is `beads-remote`'s discipline with a
different backend.

**Field mapping.** The board's `wanted` row is close enough to a
mesh/1 request that the adapter is a projection, not a translation:

| mesh/1 | `wanted` | note |
| --- | --- | --- |
| `id` | `id` (`w-<hash>`) | see the id collision below |
| `title` | `title` | 1:1 |
| `body` | `description` | 1:1 |
| `terms.priority` (`p0`–`p4`) | `priority` (0–4) | same scale, `pN` → `N` |
| `from` | `posted_by` | the rig handle |
| — | `project`, `type`, `effort_level`, `tags` | board-local vocabulary, left unset |

`claim` → `claimed_by` + `status=claimed`; `result` → a `completions`
row carrying `evidence`; `accept`/`reject` → the completion's
validated/rejected state.

**One id, one direction.** mesh ids are requester-side (`req-…`, bead
ids); board ids are `w-<hash>`. A request visible on both planes has
two identities, so exactly one is authoritative: **on the board plane
the thread is the `wanted.id`**, and the requester's mirror bead
records it in a single field. The reverse mapping is never
reconstructed — the same "re-deriving the edge bd holds is a second
source of truth" argument that keeps `--for <bead>` out of `bro wait`
applies here, and it is why the board id is never parsed back out of
the mirror.

**Reputation stays wasteland's.** `wl accept` issues reputation
stamps; mesh/1 lists reputation scoring as a v1 non-goal
(specs/mesh). The adapter reads and writes the board and **does not
import stamps into bro**. A rig's character sheet is the board's
record, and bro gains no shadow copy of it.

**The `wl` CLI is the transport, not an embedded SDK.** The mesh spec
already rejected embedding the SDK as core (it couples v1 to a
DoltHub-hosted protocol). The adapter shells to `wl` exactly the way
`mesh/pull.ts` shells to `dolt`: the SDK would be a second
implementation of the same protocol, and it would be the one that
drifts. `wl` is absent on most machines, so every wasteland call
degrades to an error line naming the missing binary — the fail-open
policy `syncReplica` already uses for an unfetchable peer.

## Non-goals (this phase)

- **A general transport SDK.** Two bindings, each a thin shell-out
  over its native CLI. A `Transport` interface over beads/dolt/github/
  wasteland is the thing to build when the *third* non-beads plane
  shows up and the seams are known to be the same.
- **Any `external:` dep on a non-beads target.** Named above as
  broken on 1.3.1 for a reason that predates this phase.
- **Label-derived envelope fields.** 50 characters is the whole budget
  and it is not enough for the ref/evidence scheme.
- **Reputation, stamps, `the-pile` profiles, sandbox tiers** — the
  board's own vocabulary, read-only to bro where it is read at all.
- **Making bd resolve mesh refs.** bd's split of `external:` on the
  first colon cannot represent `mesh://<org>/<repo>`; that is an
  upstream beads issue and the fix is not bro's to make inside this
  phase. The mirror-bead design makes it unnecessary here.
- **A waiter with its own exit-code table.** The github plane's
  waiter is the thread reduction; WAIT's verdict table belongs to the
  beads plane and re-deriving it for issues would duplicate a
  judgement, not a read.
- **Fanout or claiming for a third party** — a session that posts to
  the board does not work the board.

## Owns

```text
packages/mesh/src/github.ts       envelope→issue body render + parse,
                                  label index (≤50 chars), author
                                  provenance, issue/comment reads
packages/mesh/src/wasteland.ts    wl CLI adapter: wanted row projection,
                                  claim/completion verbs, handle registry
packages/mesh/src/peers.ts        `github` | `wasteland` transport rows
packages/cli/src/commands/mesh.ts github/wasteland delivery + inbox
                                  pass-through; `bro request` routing
AGENTS.md                         the no-checkout plane clause
```

## Plan

- [ ] `packages/mesh/src/github.ts` — `renderRequestBody`
      (fenced + marked block), `parseIssueBody` (last fenced `json`
      block that validates; unparseable → error line, never a
      request), `routingLabels` (drop-if-over-50, no truncation),
      `postRequest` (REST `labels[]`, not `gh issue create --label`),
      `issueComments` (envelope-bearing comments → `PeerRecord`s with
      author provenance), `scanIssues` (label-narrowed, body-verified)
- [ ] `packages/mesh/src/wasteland.ts` — `wl` invocation + missing-
      binary fail-open, `postWanted` / `claimWanted` /
      `completeWanted`, `browseWanted` (open board → envelopes),
      `priorityTerms` (`pN` ↔ 0–4), board id as the thread id
- [ ] `packages/mesh/src/peers.ts` — extend `TRANSPORTS` with
      `github` and `wasteland`; derivation from remote shape (github
      URL / `wl` remote); explicit override keeps working, and an
      unrecognised explicit value stays `null`
- [ ] `packages/cli/src/commands/mesh.ts` — `github` and `wasteland`
      delivery in `bro request`; both planes in `bro mesh inbox`;
      thread read over issue comments in `bro mesh wait`
- [ ] `bro mesh inbox` must not silently drop an unbound plane — a
      peer that fails to sync is an error line (the `syncReplica`
      fail-open rule), and `github`'s missing label set is likewise
      reported rather than read as "no requests"
- [ ] AGENTS.md foreign-findings bullet — one clause: a rig with no
      checkout is reached over the github issue plane, never patched
- [ ] tests: body round-trip (render → parse → identical envelope);
      last-fence-wins with an edited body and an appended footer; a
      body with no valid block → error line; label budget (a >50-char
      `mesh:to:` is dropped, never truncated, and the envelope still
      parses from the body); REST delivery auto-creates missing labels;
      provenance mismatch (author ≠ binding) flagged, not admitted;
      `external:` + `mesh://` mis-parse regression test documenting the
      project=`mesh` outcome so the mirror-bead decision cannot be
      silently reverted; wasteland wanted-row projection round-trip and
      `pN` ↔ 0–4; `wl` absent → error line naming the binary, not a
      crash
- [ ] e2e (gated, opt-in, skipped when unauthenticated): two rigs,
      request → issue → worker claim comment → result comment →
      requester accept — run against two orgs the team controls, which
      is also what settles the unverified issue-create half above; and a
      wasteland post → claim → done against a local `wl --remote-base`
      file provider

## Alternatives

- **Reuse `bro wait external:<ref>` by giving github a fake project
  name** — rejected: bd resolves external refs by opening a beads
  store at a filesystem path. There is no path behind an issue, and on
  1.3.1 nothing resolves at all. A ref that can never release is worse
  than no ref, because it reads as a block that bd will keep.
- **Put the envelope in a gist or a repo file instead of an issue** —
  rejected: it loses issue comments, which are the only append-only
  authenticated channel a foreign surface offers, and it invents a
  second place to look for every request.
- **Put the envelope in the issue *title*** — rejected: titles cap at
  256 characters and are the one field humans rewrite.
- **Carry refs/evidence as labels on github, truncating to fit** —
  rejected: truncation produces a distinct string that matches
  nothing, and the 50-char budget is already exceeded by real URLs.
  The body carries them.
- **`gh issue create --label` for delivery** — rejected: it hard-fails
  on a label the repo does not have yet, so the first delivery on any
  repo fails and every one after it fails the same way. The REST path
  creates the labels.
- **Trust the envelope's `from` on github** — rejected: the
  authenticated author is sitting right there in the API response.
  Ignoring it to honour an advisory field would be strictly worse than
  the beads plane, where provenance is only as good as the binding.
- **Embed the wasteland SDK in `@broject/mesh`** — rejected earlier in
  specs/mesh for coupling v1 to DoltHub; unchanged. `wl` is the
  transport, the same way `dolt` is.
- **Import wasteland reputation stamps into bro** — rejected:
  reputation is a mesh/1 non-goal, and a shadow copy of a character
  sheet is a second source of truth that will drift from the board.
- **One `Transport` interface across all four bindings now** —
  rejected as premature: with two bead-shaped and two not, the seam is
  still being discovered. The github and wasteland modules keep their
  own shape and share only the envelope.

## Related

- specs/mesh/spec.md — envelope, lifecycle, the transport table's
  `github` and `wasteland` rows, Trust, and the two non-goals this
  phase leans on (reputation, encryption/identity proofs).
- specs/cross-repo/bro-oam4.md — LOCAL: `bro request`, the anchor-store
  delivery, and the peer-binding ensure this phase extends.
- specs/cross-repo/bro-y5zcw.md — WAIT: `bro wait external:<ref>`, and
  its explicit hand-off of the issue/wasteland plane here.
- specs/cross-repo/spec.md — the phase map (LOCAL / WAIT / REMOTE).
- bro-5nnj — epic; bro-5eaa — mesh epic.
- Upstream read during design: `gastownhall/wasteland` README and
  `schema/commons.sql` (wanted/rigs/completions shape, join-by-fork,
  PR mode); `gastownhall/beads` `internal/storage/externaldeps/*` and
  `engdocs/design/external-capability-dependencies.md` (why the
  `external:` ref is inert on 1.3.1); bd 1.3.1 and the GitHub REST API
  probed directly for the label and permission claims above.
