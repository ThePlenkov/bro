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