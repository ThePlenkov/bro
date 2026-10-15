## 0.2.5 (2026-10-07)

### 🚀 Features

- **act:** blocked act-wait settle surfaces as a finding (bro-q4iq0) ([#380](https://github.com/theplenkov/bro/pull/380))
- **act:** merge queue for every PR + opt-in external queue connectors (bro-huy5o.6) ([#388](https://github.com/theplenkov/bro/pull/388))
- **act:** act wait --detach — a watcher that outlives the session ([#450](https://github.com/theplenkov/bro/pull/450))
- **agents:** agents.devin.maxWorkers — split the spawn-plane quota ([#410](https://github.com/theplenkov/bro/pull/410))
- **agents:** docker container isolation backend (bro-huy5o.10) ([#438](https://github.com/theplenkov/bro/pull/438))
- **agents:** copilot agent-task connector — first cloud backend (bro-huy5o.12) ([#447](https://github.com/theplenkov/bro/pull/447))
- **beads:** .beads store on a managed dolt sql-server (bro-n59xn) ([#405](https://github.com/theplenkov/bro/pull/405))
- **build:** session-attributed build stamp — who last wrote dist is recorded (bro-fatja) ([#402](https://github.com/theplenkov/bro/pull/402))
- **claude:** install the plugin from the repo root ([#395](https://github.com/theplenkov/bro/pull/395))
- **cli:** command groups — bro <group> <member> dispatch (bro-b5v2t) ([#396](https://github.com/theplenkov/bro/pull/396))
- **cli:** land cli spec + migrate docs to grouped spelling (bro-vlmrb.1/.2) ([#459](https://github.com/theplenkov/bro/pull/459))
- **cli:** optional OTLP export of the session trace journal (bro-huy5o.11) ([#439](https://github.com/theplenkov/bro/pull/439))
- **codex:** native plugin hooks and prompt-visible skills ([#369](https://github.com/theplenkov/bro/pull/369))
- **daemon:** bro daemon — the project-scoped process owner (bro-ybrja) ([#424](https://github.com/theplenkov/bro/pull/424))
- **debt:** sonarcloud source — issues + hotspots on new code (bro-huy5o.4) ([#400](https://github.com/theplenkov/bro/pull/400))
- **debt:** codacy + codescene debt sources (bro-huy5o.5) ([#483](https://github.com/theplenkov/bro/pull/483))
- **doctor:** warn when dev-checkout bro on PATH predates checkout HEAD (bro-s7vgd) ([#419](https://github.com/theplenkov/bro/pull/419))
- **doctor:** warn when a client classifier rides the acp conductor (bro-9ww2q) ([#523](https://github.com/theplenkov/bro/pull/523))
- **dogfood:** scenario-driven e2e self-test — bro self dogfood ([#497](https://github.com/theplenkov/bro/pull/497))
- **drive:** ci-fail and sast blockers spawn per-class fixers (bro-atb2g) ([#462](https://github.com/theplenkov/bro/pull/462))
- **drive:** bro drive install — armed want-marker, checkpoint rearm (bro-y5zon) ([#468](https://github.com/theplenkov/bro/pull/468))
- **events:** github webhook ingest → github:* bus topics (bro-huy5o.7) ([#389](https://github.com/theplenkov/bro/pull/389))
- **fleet:** judge router classifies unclassed mol steps (bro-9kqvy) ([#364](https://github.com/theplenkov/bro/pull/364))
- **fleet:** bro fleet resume — the post-restart runbook as one pass ([#496](https://github.com/theplenkov/bro/pull/496))
- **goal:** session-scoped completion goals — bro goal + hook reminders (bro-6vcll) ([#365](https://github.com/theplenkov/bro/pull/365))
- **jira:** tasks connector over the atlassian CLI (bro-huy5o.3) ([#435](https://github.com/theplenkov/bro/pull/435))
- **loop:** route agent spawns through the provider registry (bro-c3no8) ([#370](https://github.com/theplenkov/bro/pull/370))
- **loop:** task-stack round-robin — service gate updates instead of idling (bro-zsmwq) ([#384](https://github.com/theplenkov/bro/pull/384))
- **loop:** batch claims — N same-affinity beads, one worker, one PR ([#397](https://github.com/theplenkov/bro/pull/397), [#42](https://github.com/theplenkov/bro/issues/42))
- **loop:** spawn workers through the agents registry — the tick never awaits a worker (bro-zpa93) ([#399](https://github.com/theplenkov/bro/pull/399))
- **loop:** disk floor admission — pushes hold when free disk < N×worktreeMb (bro-2spp7) ([#407](https://github.com/theplenkov/bro/pull/407))
- **loop:** beads materialize as tracker issues at PR-armed time (bro-z2z7f) ([#411](https://github.com/theplenkov/bro/pull/411))
- **loop:** PR ownership marking — bro-managed label + body trailer (bro-c650l) ([#457](https://github.com/theplenkov/bro/pull/457))
- **notify:** webhook sinks — slack, telegram, generic (bro-huy5o.8) ([#436](https://github.com/theplenkov/bro/pull/436))
- **planes:** bro mcp — stdio MCP server over read planes (bro-9rls.2) ([#387](https://github.com/theplenkov/bro/pull/387))
- **provider:** host-level listener + url/token/env helpers — one settings.json wire for every claude (bro-om6m8.1) ([#500](https://github.com/theplenkov/bro/pull/500))
- **pulse:** bro pulse — the session-owned metronome (bro-ijffz) ([#474](https://github.com/theplenkov/bro/pull/474))
- **rig:** bro rig — the rig's own checkout keeps itself current (bro-te73m) ([#403](https://github.com/theplenkov/bro/pull/403))
- **serve:** real /fleet dashboard — agents+queue+PRs+ticks+mailbox (bro-w4a45) ([#421](https://github.com/theplenkov/bro/pull/421))
- **serve:** /v1/* Messages-API provider plane — bro as a Claude Code provider ([#495](https://github.com/theplenkov/bro/pull/495))
- **stack:** connector facade for platform stack ops — bro stack merge (bro-r6vge) ([#378](https://github.com/theplenkov/bro/pull/378))
- **stack:** register member PRs as the host stack via gh stack link (bro-z76f2) ([#406](https://github.com/theplenkov/bro/pull/406))
- **status:** worktree plane on the live board (bro-0vj14) ([#504](https://github.com/theplenkov/bro/pull/504))
- **supervisors:** one drive/loop per repo — heartbeated singleton hold (bro-2duu9) ([#414](https://github.com/theplenkov/bro/pull/414))
- **tasks:** github-issues tasks connector — zero-install task store (bro-huy5o.1) ([#371](https://github.com/theplenkov/bro/pull/371))
- **tasks:** linear connector — TaskStore + queries facade (bro-huy5o.2) ([#383](https://github.com/theplenkov/bro/pull/383))
- **tasks:** batch serial bd-show — TaskStore getMany bulk read + degrade helpers (bro-hcx5p) ([#458](https://github.com/theplenkov/bro/pull/458))
- **telemetry:** command-level timing + bro telemetry report (bro-537yo) ([#367](https://github.com/theplenkov/bro/pull/367))
- **telemetry:** rig lifecycle journal — one ordered JSONL the planes read (bro-ub91h) ([#408](https://github.com/theplenkov/bro/pull/408))
- **watch:** durable heartbeat file — overnight state is a read (bro-dxoa5) ([#415](https://github.com/theplenkov/bro/pull/415))
- **watch:** session pulse replaces OS timers — armed marker + lock + rearm nudge (bro-killn) ([#420](https://github.com/theplenkov/bro/pull/420))
- **watch:** postTool checkpoint rearms the pulse — zero-cost, no LLM (bro-killn) ([#422](https://github.com/theplenkov/bro/pull/422))

### 🩹 Fixes

- **act:** rearm sees real wait markers; loop gate waits arm them (bro-z0k2u) ([#372](https://github.com/theplenkov/bro/pull/372))
- **act:** carry loop-claimed bead through rearmed watch markers (bro-q6ppv) ([#391](https://github.com/theplenkov/bro/pull/391))
- **act:** shared gate-state feed — one fetch per PR per TTL (bro-0tcrl) ([#470](https://github.com/theplenkov/bro/pull/470))
- **bd:** unambiguous BD_NOT_FOUND id token (CodeQL js/polynomial-redos) ([#456](https://github.com/theplenkov/bro/pull/456))
- **beads:** validate + escape PATH-resolved doltBin in systemd ExecStart ([#491](https://github.com/theplenkov/bro/pull/491))
- **cli:** absolutize the self-respawn entry at module load (bro-meqjk) ([#455](https://github.com/theplenkov/bro/pull/455))
- **cli:** discharge re-reads a prefetched `closed` row before skipping (bro-cmr5h) ([#489](https://github.com/theplenkov/bro/pull/489))
- **cli:** bound lock-holder liveness by the steal rule (bro-8o9f8) ([#494](https://github.com/theplenkov/bro/pull/494))
- **cli:** merge-path occupancy TTL for green PRs (bro-ihnlv) ([#467](https://github.com/theplenkov/bro/pull/467))
- **core:** bound bd calls with timeout supervisor + janitor orphan sweep (bro-8845g) ([#404](https://github.com/theplenkov/bro/pull/404))
- **core:** bridge dolt git remotes through a managed local mirror (bro-wxgt3) ([#461](https://github.com/theplenkov/bro/pull/461))
- **core:** bound batched task reads under the OS argv cap (bro-n9dot) ([#493](https://github.com/theplenkov/bro/pull/493))
- **daemon:** scope the supervisor down-sweep to this repo (bro-cx1s6) ([#522](https://github.com/theplenkov/bro/pull/522))
- **doctor:** format derived RigRef in mesh row — was printing [object Object] (bro-jkwm2) ([#448](https://github.com/theplenkov/bro/pull/448))
- **dogfood:** arm sdd.mode=gate in the scratch repo config (bro-g48r4) ([#516](https://github.com/theplenkov/bro/pull/516))
- **drive:** spawn a rebase fixer on conflicted orphan PRs (bro-glkes) ([#412](https://github.com/theplenkov/bro/pull/412))
- **drive:** count failed branch listings as incomplete enumeration (bro-izrgw) ([#428](https://github.com/theplenkov/bro/pull/428))
- **drive:** skip PRs a live supervisor marker already owns (bro-0aa87) ([#373](https://github.com/theplenkov/bro/pull/373))
- **github:** bound the check-annotations fan-out (bro-2l7r9) ([#413](https://github.com/theplenkov/bro/pull/413))
- **github:** heal stale external_ref on re-publish — stop duplicate issues ([#446](https://github.com/theplenkov/bro/pull/446))
- **guard:** record-path throw must never discard decided lines (bro-oahg) ([#512](https://github.com/theplenkov/bro/pull/512))
- **homebrew:** require a full vX.Y.Z dispatch tag (bro-tkuse) ([#423](https://github.com/theplenkov/bro/pull/423))
- **homebrew:** order semver prereleases below finals in downgrade check ([#425](https://github.com/theplenkov/bro/pull/425))
- **hooks:** post-merge installs the dep graph before build (bro-sovl3) ([#385](https://github.com/theplenkov/bro/pull/385))
- **hooks:** claimed-beads stop nudge only reaches task-armed sessions (bro-hpb35) ([#506](https://github.com/theplenkov/bro/pull/506))
- **hooks:** subtract spawn-pinned claims from the parallel-work nudge (bro-qteky) ([#519](https://github.com/theplenkov/bro/pull/519))
- **loop:** strict flag parse — unquoted --agent tail spawned interactive devin TUIs ([#366](https://github.com/theplenkov/bro/pull/366))
- **loop:** close-out reaps its own loop/* worktree litter (bro-co9nj) ([#379](https://github.com/theplenkov/bro/pull/379))
- **loop:** work-order checkpoints commit+push before deep verification (bro-d6k4v) ([#392](https://github.com/theplenkov/bro/pull/392))
- **loop:** never exit silently mid-run — heartbeat + death audit (bro-snga4) ([#376](https://github.com/theplenkov/bro/pull/376))
- **loop:** no wall-clock agent kill — stall is an advisory read at check-in (bro-9lpn3) ([#377](https://github.com/theplenkov/bro/pull/377))
- **loop:** trim worker cold-start noise — disable dead config importers (bro-5lfp1) ([#401](https://github.com/theplenkov/bro/pull/401))
- **loop:** clamp silentMs at 0 — sub-ms mtime vs floored Date.now() read negative (bro-zigwt) ([#416](https://github.com/theplenkov/bro/pull/416))
- **loop:** exit audit survives a failing bro sync — throws, never exits (bro-qjbwq) ([#441](https://github.com/theplenkov/bro/pull/441))
- **loop:** release orphaned claims + bound parked worktrees (bro-ho09d) ([#398](https://github.com/theplenkov/bro/pull/398))
- **loop:** parked beads snooze the claim instead of holding it forever ([#472](https://github.com/theplenkov/bro/pull/472))
- **loop:** surface live registry-path loop workers in watch/status (bro-wg896) ([#476](https://github.com/theplenkov/bro/pull/476))
- **loop:** resolve fleet.routing class per bead (bro-zmned) ([#393](https://github.com/theplenkov/bro/pull/393))
- **mesh:** drop verdicted threads from inbox (bro-2o3cw) ([#359](https://github.com/theplenkov/bro/pull/359))
- **release:** derive publish.yml package set, mark bundled internals private ([#345](https://github.com/theplenkov/bro/pull/345))
- **retro:** make the learn-capture persist step explicit (bro-l2sm) ([#452](https://github.com/theplenkov/bro/pull/452))
- **rig:** absolutize the rig-pulse respawn entry via SELF_ENTRY (bro-meqjk) ([#515](https://github.com/theplenkov/bro/pull/515))
- **rig:** pin rig pulse spawn record against pid reuse (bro-t2jc1) ([#514](https://github.com/theplenkov/bro/pull/514))
- **scripts:** %-escape dolt binary path in dolt-server unit ExecStart (bro-9v45) ([#511](https://github.com/theplenkov/bro/pull/511))
- **serve:** hold serve.json.lock heartbeated via holdFileLock (bro-5lngt) ([#445](https://github.com/theplenkov/bro/pull/445))
- **spec:** exempt molecule issue_type from spec check (bro-6z124) ([#360](https://github.com/theplenkov/bro/pull/360))
- **status:** route worktree test through testGit — merge race broke main ([#532](https://github.com/theplenkov/bro/pull/532))
- **sync:** tolerate absent refs/bro/data on pull — empty restore is not an error (bro-e1e3p) ([#485](https://github.com/theplenkov/bro/pull/485))
- **tasks:** bro trailer counts only as the body's last element (bro-awwzc) ([#444](https://github.com/theplenkov/bro/pull/444))
- **watch:** pin pulse spawn record against pid reuse (bro-t2jc1) ([#454](https://github.com/theplenkov/bro/pull/454))
- **watch:** bound the pulse-spawn trust window both directions (bro-zplip) ([#487](https://github.com/theplenkov/bro/pull/487))
- **watch:** gates discovers open PRs via fleet branches, not the registry (bro-hn7kx) ([#501](https://github.com/theplenkov/bro/pull/501))
- **watch:** bound persisted pulse cadences by the shared interval floor (bro-sg6e) ([#510](https://github.com/theplenkov/bro/pull/510))

### 🔥 Performance

- **guard:** sweep probes and defs in parallel (bro-nfl5s) ([#390](https://github.com/theplenkov/bro/pull/390))
- **hooks:** overlap probe stages + memoize session context — stop 6.4s→3.6s (bro-wc0i6) ([#368](https://github.com/theplenkov/bro/pull/368))
- **learn:** batch capture's bd reads — O(1) calls, not O(rows) (bro-rcs07) ([#443](https://github.com/theplenkov/bro/pull/443))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov

## 0.2.4 (2026-09-30)

### 🚀 Features

- **cli:** bro doctor — environment diagnostics command (bro-2vt) ([#148](https://github.com/ThePlenkov/bro/pull/148))
- **core:** bd compat check + graceful jsonl degrade (bro-y1b) ([#151](https://github.com/ThePlenkov/bro/pull/151))
- **core:** 0.x contract stability — changelog + deprecation seams (bro-7ix) ([#153](https://github.com/ThePlenkov/bro/pull/153))
- **debt:** announce stealth .beads init — beads stays a default store (bro-0fc) ([#152](https://github.com/ThePlenkov/bro/pull/152))
- **debt:** bro debt trend — burn-down over time (bro-55t) ([#157](https://github.com/ThePlenkov/bro/pull/157))
- **gitlab:** second connector — ReviewFacade over glab (bro-00t) ([#149](https://github.com/ThePlenkov/bro/pull/149))
- **next,loop:** declared label scope — loops can't bleed across the queue (bro-idk7) ([#167](https://github.com/ThePlenkov/bro/pull/167))
- **plans:** versioned plan schemas + bro plan validate (bro-2u5) ([#150](https://github.com/ThePlenkov/bro/pull/150))
- **setup:** @broject/bro-pack — capabilities ship as an npm pack ([#165](https://github.com/ThePlenkov/bro/pull/165))
- **site:** /debt — bro's own debt dashboard, live from refs/bro/data ([#166](https://github.com/ThePlenkov/bro/pull/166))
- **site:** /debt shows harvested findings, not only the status overlay ([#168](https://github.com/ThePlenkov/bro/pull/168))

### 🩹 Fixes

- debt batch — bd diagnostics, merge semantics, doc-dispatch namespace ([#102](https://github.com/ThePlenkov/bro/pull/102))
- **ci,cli:** release-tag fallback searches ancestry; cleanup degrade-path tests (bro-p1sm, bro-ara7) ([#160](https://github.com/ThePlenkov/bro/pull/160))
- **cli:** cleanup treats review-host auth as a warning, not a gate (bro-owg) ([#130](https://github.com/ThePlenkov/bro/pull/130))
- **cli:** own-keys check for reserved doc nouns (bro-ff6) ([#154](https://github.com/ThePlenkov/bro/pull/154))
- **cli:** memoize filtered doc types — one collision warning per process (bro-zpf) ([#155](https://github.com/ThePlenkov/bro/pull/155))
- **cli:** reserve plugin command names in the doc-type guard (bro-e8o) ([#156](https://github.com/ThePlenkov/bro/pull/156))
- **cli:** debt watch syncs the ledger to gitref per tick (bro-mtwa) ([#162](https://github.com/ThePlenkov/bro/pull/162))
- **cli:** debt watch — fail-fast auth at startup, throw per tick ([#161](https://github.com/ThePlenkov/bro/pull/161))
- **cli:** read-only debt commands no longer publish the ledger ([#163](https://github.com/ThePlenkov/bro/pull/163))
- **cli:** flag() recognizes --name=value — a missed label scope was fail-open ([#171](https://github.com/ThePlenkov/bro/pull/171))
- **cli:** drop argv.includes gates — --label=v never reached flag() ([#172](https://github.com/ThePlenkov/bro/pull/172))
- **debt:** sweep security + review findings — axios override, ci permissions, --label repeat ([#170](https://github.com/ThePlenkov/bro/pull/170))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov

## 0.2.3 (2026-09-30)

### 🚀 Features

- **site:** one template — minimal landing + docs on TanStack Start + Fumadocs ([#119](https://github.com/theplenkov/bro/pull/119))

### 🩹 Fixes

- **ci:** release-tag falls back to second-parent subject on merge commits (bro-zra) ([#127](https://github.com/theplenkov/bro/pull/127))
- **cli:** gate gh auth before repo resolution in debt commands (bro-5yu) ([#131](https://github.com/theplenkov/bro/pull/131))
- **cli:** align engines floor with prepack's .ts execution (bro-5ce) ([#143](https://github.com/theplenkov/bro/pull/143))
- **core:** verify assignee before a .task marker counts as own claim (bro-4xl) ([#129](https://github.com/theplenkov/bro/pull/129))
- **core:** name the plugin when auth probe breaks the sync contract (bro-5yh) ([#132](https://github.com/theplenkov/bro/pull/132))
- **core:** memoize connector auto-detect — ambiguity warning prints once (bro-2i8) ([#133](https://github.com/theplenkov/bro/pull/133))
- **core:** claim ownership follows the serving task store's actor (bro-cwgv) ([#144](https://github.com/theplenkov/bro/pull/144))
- **github:** throw on MERGED PR with null mergedAt (bro-olj) ([#136](https://github.com/theplenkov/bro/pull/136))
- **github:** surface batch-wide explicitMergedPrs failures (bro-dv4) ([#137](https://github.com/theplenkov/bro/pull/137))
- **github:** bound matchRemote to the github.com edge (bro-8l8) ([#138](https://github.com/theplenkov/bro/pull/138))
- **github:** dedupe explicit mergedPrs ids at the facade (bro-tmk) ([#140](https://github.com/theplenkov/bro/pull/140))
- **github:** type ThreadPage.line as number | null (bro-o08) ([#141](https://github.com/theplenkov/bro/pull/141))
- **loop:** pin agent BEADS_DIR to the shared store; honor bd close as a verdict ([#128](https://github.com/theplenkov/bro/pull/128))
- **release:** match only open PRs before skipping release-PR creation ([#126](https://github.com/theplenkov/bro/pull/126))

### 🔥 Performance

- **core:** memoize bdActor probe per dir (bro-l7b9) ([#145](https://github.com/theplenkov/bro/pull/145))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Devin AI @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov

## 0.2.2 (2026-09-29)

Changes in this release predate conventional-commit discipline, so the
generator saw no typed commits. Shipped:

- **debt:** multi-source collectors — dependabot, code-scanning,
  secret-scanning, stale-prs, failed-ci ([#112](https://github.com/theplenkov/bro/pull/112))
- **nx:** @nx-devkit/prepare-for-release plugin — npm bootstrap + OIDC
  trust ([#114](https://github.com/theplenkov/bro/pull/114))
- **cli:** drop @broject/* devDeps from the published manifest ([#115](https://github.com/theplenkov/bro/pull/115))
- **cli:** resolve conflict markers committed into package.json ([#116](https://github.com/theplenkov/bro/pull/116))

## 0.2.1 (2026-09-29)

### 🚀 Features

- bro drill — scoped descent over beads + agent plugin ([#18](https://github.com/theplenkov/bro/pull/18))
- gitref store backend — artifact sync on refs/bro/data ([#45](https://github.com/theplenkov/bro/pull/45))
- **act:** bro act merge — gate-enforced merge ([#29](https://github.com/theplenkov/bro/pull/29))
- **act:** act.ignoreChecks — advisory checks exit the gate ([#47](https://github.com/theplenkov/bro/pull/47))
- **act:** bound the act loop — act.maxRounds caps inline fix rounds ([#54](https://github.com/theplenkov/bro/pull/54))
- **act:** plan schema — batch thread verdicts via bro run ([#68](https://github.com/theplenkov/bro/pull/68))
- **act:** bro act wait — the gate-watcher as a primitive ([#72](https://github.com/theplenkov/bro/pull/72))
- **act:** merge-slot — serialize merges via bd ([#67](https://github.com/theplenkov/bro/pull/67))
- **act:** wait auto-updates BEHIND branches — the update-branch button as code ([#81](https://github.com/theplenkov/bro/pull/81))
- **cli:** bro cleanup — post-merge branch hygiene as mechanics ([#33](https://github.com/theplenkov/bro/pull/33))
- **cli:** plugin registry — every command as a BroPlugin ([#48](https://github.com/theplenkov/bro/pull/48))
- **cli:** external plugins via config plugins — bro is a host now ([#51](https://github.com/theplenkov/bro/pull/51))
- **cli:** bare commands act on context ([#57](https://github.com/theplenkov/bro/pull/57))
- **cli:** @theplenkov/bro/plugin — typed API for external plugins ([#59](https://github.com/theplenkov/bro/pull/59))
- **cli:** bro work — parallel-friendly worktree lifecycle ([#60](https://github.com/theplenkov/bro/pull/60))
- **cli:** bro loop — the autonomous backlog runner as a command ([#75](https://github.com/theplenkov/bro/pull/75))
- **cli:** clickable PR links — bare #N is dead text ([#97](https://github.com/theplenkov/bro/pull/97))
- **config:** linked worktrees inherit the main checkout's bro.config ([#74](https://github.com/theplenkov/bro/pull/74))
- **convoy:** agent-internal molecule execution — bro convoy ([#28](https://github.com/theplenkov/bro/pull/28))
- **convoy:** plan schema — pour plans for molecule execution ([#78](https://github.com/theplenkov/bro/pull/78))
- **core:** bro.config.ts support ([#44](https://github.com/theplenkov/bro/pull/44))
- **core:** plugin-owned config sections via configSchema ([#49](https://github.com/theplenkov/bro/pull/49))
- **core:** unified plans — kind envelope + bro run ([#53](https://github.com/theplenkov/bro/pull/53))
- **debt:** beads store on by default — auto bd init, ledger git-excluded ([#26](https://github.com/theplenkov/bro/pull/26))
- **debt:** plan schema — batch triage via bro run ([#66](https://github.com/theplenkov/bro/pull/66))
- **drill:** plan schema — declared descent trees via bro run ([#70](https://github.com/theplenkov/bro/pull/70))
- **gen-plugins:** validate plugin.json shape + sync version with cli ([#27](https://github.com/theplenkov/bro/pull/27))
- **hooks:** devin lifecycle bridge — rehydrate, stop-gate, self-approve ([#21](https://github.com/theplenkov/bro/pull/21))
- **next:** bro next — the autonomous backlog scheduler ([#61](https://github.com/theplenkov/bro/pull/61))
- **next:** plan schema — selection/execution plans via bro run ([#79](https://github.com/theplenkov/bro/pull/79))
- **retro:** bro wtf + bro retrospect — self-correction over beads ([#19](https://github.com/theplenkov/bro/pull/19))
- **site:** docs + landing on GitHub Pages ([#55](https://github.com/theplenkov/bro/pull/55))
- **sync:** orchestrate bd sync — beads state rides along ([#73](https://github.com/theplenkov/bro/pull/73))
- **work:** submodule lifecycle + bead claim on enter ([#80](https://github.com/theplenkov/bro/pull/80))

### 🩹 Fixes

- npm 11 for OIDC trusted publishing ([#14](https://github.com/theplenkov/bro/pull/14))
- strip placeholder _authToken so OIDC publishing engages ([#15](https://github.com/theplenkov/bro/pull/15))
- publish dispatch decouples run-ref from publish-ref ([#17](https://github.com/theplenkov/bro/pull/17))
- stale-status gate on non-OPEN PRs + non-object config roots ([#30](https://github.com/theplenkov/bro/pull/30))
- debt batch — push-accurate fixRounds, defer-aware hook, setup .ts guard ([#58](https://github.com/theplenkov/bro/pull/58))
- **act:** normalize mergeState casing at the fetch boundary ([#39](https://github.com/theplenkov/bro/pull/39))
- **act:** guard reply comment + finish defer title message ([#71](https://github.com/theplenkov/bro/pull/71))
- **act,wtf:** policy at the point of use — silent-resolve guardrail + sink escalation ([#82](https://github.com/theplenkov/bro/pull/82))
- **config:** see through --separate-git-dir for worktree inheritance ([#76](https://github.com/theplenkov/bro/pull/76))
- **drill:** retry-safe drillUp — idempotent prevention creation ([#31](https://github.com/theplenkov/bro/pull/31))
- **drill:** fail loud on wrong-shaped bd dep list rows ([#35](https://github.com/theplenkov/bro/pull/35))
- **drill:** normalize prevention-title dedupe — trim + case-fold ([#36](https://github.com/theplenkov/bro/pull/36))
- **drill:** keep the original error through drillUp's compensation ([#38](https://github.com/theplenkov/bro/pull/38))
- **gen-plugins:** slug regex must anchor end on alphanumeric ([#40](https://github.com/theplenkov/bro/pull/40))
- **gen-plugins:** batch reviewer findings — validation + fs safety ([#42](https://github.com/theplenkov/bro/pull/42))
- **hooks:** never assume $DEVIN_PLUGIN_ROOT — guard + fallback chain ([#22](https://github.com/theplenkov/bro/pull/22))
- **hooks:** session-scoped stop gate — ambient state is context, not a block ([#34](https://github.com/theplenkov/bro/pull/34))
- **next:** scope the queue to issue_prefix — foreign beads never claimed ([#87](https://github.com/theplenkov/bro/pull/87))

### 🔥 Performance

- **drill:** batch parent-child edges via bd dep list ([#50](https://github.com/theplenkov/bro/pull/50))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov

## 0.2.0 (2026-09-15)

### 🚀 Features

- CI release pipeline via nx release ([#13](https://github.com/theplenkov/bro/pull/13))
- **debt:** debt next + debt watch ([#11](https://github.com/theplenkov/bro/pull/11))

### 🩹 Fixes

- harvested review findings — SAST unknown gate, personality validation, atomicWrite perms ([#9](https://github.com/theplenkov/bro/pull/9))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov

## 0.1.0 (2026-09-15)

### 🚀 Features

- bro act + bro setup + beads formula ([#4](https://github.com/theplenkov/bro/pull/4))
- **debt:** bro debt sync — ledger → beads projection ([#3](https://github.com/theplenkov/bro/pull/3))

### 🩹 Fixes

- **ci:** build vendored nx plugins before nx targets ([422e7fa](https://github.com/theplenkov/bro/commit/422e7fa))
- **ci:** route build/test through npm scripts for skills-* exclusion ([ac00b43](https://github.com/theplenkov/bro/commit/ac00b43))
- **cli:** drop ./ prefix from bin path ([#6](https://github.com/theplenkov/bro/pull/6))
- **debt:** review findings from skills#309 ([#1](https://github.com/theplenkov/bro/pull/1), [#309](https://github.com/theplenkov/bro/issues/309))
- **debt:** never remove debt:skipped from collect path ([#2](https://github.com/theplenkov/bro/pull/2))
- **debt:** rescan labeled PRs with post-scan activity ([#5](https://github.com/theplenkov/bro/pull/5))

### ❤️ Thank You

- Devin @devin-ai-integration[bot]
- Petr Plenkov @ThePlenkov