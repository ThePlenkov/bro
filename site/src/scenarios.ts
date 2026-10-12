export type LineKind = 'user' | 'agent' | 'tool' | 'out' | 'hook'

export interface Line {
  kind: LineKind
  text: string
}

export interface Scenario {
  id: string
  tab: string
  lines: Line[]
}

export interface Group {
  id: string
  label: string
  gist: string
  scenarios: Scenario[]
}

const user = (text: string): Line => ({ kind: 'user', text })
const agent = (text: string): Line => ({ kind: 'agent', text })
const bash = (cmd: string): Line => ({ kind: 'tool', text: `Bash(${cmd})` })
const out = (text: string): Line => ({ kind: 'out', text })
const hook = (text: string): Line => ({ kind: 'hook', text })
const bg = (cmd: string): Line => ({ kind: 'tool', text: `Bash(${cmd}) · background` })

export const groups: Group[] = [
  {
    id: 'planning',
    label: 'planning',
    gist: 'the queue is the plan. specs before code, stacks before chaos.',
    scenarios: [
      {
        id: 'next',
        tab: 'what now?',
        lines: [
          hook('SessionStart · bro: ready queue waiting · a merged PR still owes review debt'),
          user('what now, bro?'),
          bash('bro flow next'),
          out('→ claimed  "cache the avatar endpoint"'),
          out('  loop: implement → PR → bro review act merge → close → bro flow next'),
          agent('On it. No "shall I proceed?" — the queue is the plan.'),
          user('and when I sleep?'),
          bash('bro flow loop --label backend --max 5'),
          out('claim → worktree → agent → gate → close → repeat'),
          agent('Scoped to backend. The rest of the queue stays untouched.'),
        ],
      },
      {
        id: 'spec',
        tab: 'spec first',
        lines: [
          user('add rate limiting to the API'),
          bash('bd update app-7 --claim'),
          agent('Writing the middleware—'),
          hook('Stop hook · bro: app-7 is claimed without a spec — sdd.mode is gate'),
          agent('Spec first. Code second.'),
          bash('bro spec new app-7'),
          out('specs/app-7.md scaffolded from the bead title'),
          bash('bro spec check'),
          out('app-7  spec'),
          user('and the old specs?'),
          bash('bro spec drift'),
          out('app-3  STALE — the code moved, the spec did not'),
          agent('Drift is debt now, not a surprise in review.'),
        ],
      },
      {
        id: 'stack',
        tab: 'PRs on PRs',
        lines: [
          user('three beads, each builds on the last'),
          bash('bro flow stack push app-1 --name auth'),
          bash('bro flow stack push app-2 --name auth'),
          bash('bro flow stack push app-3 --name auth'),
          bash('bro flow stack list auth'),
          out('1  app-1  stack/auth/1-app-1  #61 open → main'),
          out('2  app-2  stack/auth/2-app-2  #62 open → stack/auth/1-app-1'),
          out('3  app-3  stack/auth/3-app-3  #63 open → stack/auth/2-app-2'),
          hook('PostToolUse · bro comms notify: #61 merged'),
          bash('bro flow stack sync auth'),
          out('#62 retargeted → main · app-3 rebased'),
          agent('The tower holds. Nobody rebased by hand.'),
        ],
      },
      {
        id: 'query',
        tab: 'jira + github',
        lines: [
          user('which Jira tickets have no open PR?'),
          agent('One plan, two providers. No tab-hopping.'),
          bash('bro plan query triage.toml'),
          out('{ "gh-prs": { … }, "jira-open": { … } }'),
          out('steps fanned out · one merged answer, keyed by step id'),
          agent('PROJ-12 and PROJ-19 have nobody. Filing them.'),
          bash('bro task new "PROJ-12: export is truncated"'),
          out('app-14 created'),
          agent('Now they are in the queue, not in a browser tab.'),
        ],
      },
    ],
  },
  {
    id: 'orchestration',
    label: 'orchestration',
    gist: 'background waits, subagents, handoffs, respawns. nobody blocks on anybody.',
    scenarios: [
      {
        id: 'background',
        tab: "don't wait",
        lines: [
          user('push it, then take the docs bead.'),
          bash('git push'),
          bg('bro review act wait 42 --merge'),
          bg('bro review watch --every 120 --for 900 --notify'),
          agent('Two watchers in background shells. Not subagents — zero tokens while they wait.'),
          bash('bd ready'),
          out('bro-7k2  docs: events page'),
          hook('PostToolUse · bro comms notify: watch — auth.3 lost — respawn?'),
          bash('bro fleet agents up auth.3'),
          hook('background shell done · bro review act wait 42 → exit 0'),
          out('exit_gate=OK · act: merged #42'),
          agent('#42 merged mid-paragraph. Back to the docs.'),
        ],
      },
      {
        id: 'fanout',
        tab: 'subagents',
        lines: [
          user('four independent steps. go wide.'),
          bash('bro fleet agents up auth.1'),
          bash('bro fleet agents up auth.2'),
          bash('bro fleet agents up auth.3'),
          bash('bro fleet agents up auth.4'),
          out('fleet.maxConcurrent reached — auth.4 waits its turn'),
          agent('Not waiting on them. Back to my own work.'),
          hook('PostToolUse · bro comms notify: result from auth.1 — PR #71 open, gate green'),
          bash('bro fleet'),
          out('auth.1  exited  #71'),
          out('auth.2  running'),
          out('auth.3  running'),
          agent('Completion is detected, not awaited.'),
        ],
      },
      {
        id: 'handoff',
        tab: 'handoff',
        lines: [
          agent('auth.2 is mid-migration. I am mid-something-else.'),
          hook('PostToolUse · bro comms notify: ask from native-7f3a9b2c — "users table needs a column. additive ok?"'),
          bash('bro comms notify --to native-7f3a9b2c --kind result --in-reply-to auth.2 "yes, additive only"'),
          out('addressed drop → native-7f3a9b2c · single consumer'),
          hook('PostToolUse · bro comms notify: result from native-7f3a9b2c — migration additive, PR #72 open'),
          user('nice. did anyone wait in a loop?'),
          agent('No. Write, don\'t wait. The mailbox carries it to the next tool call.'),
        ],
      },
      {
        id: 'respawn',
        tab: 'who died?',
        lines: [
          hook('SessionStart · bro: PR #74 is unwatched — its act wait died with the host'),
          bash('bro review act rearm'),
          out('#74  watcher re-armed · --merge kept'),
          bash('bro fleet agents status'),
          out('auth.3  lost — respawn?'),
          bash('bro fleet agents up auth.3'),
          out('respawned on the same agentId · claim rebound'),
          bash('bro fleet agents prune'),
          out('terminal entries reaped'),
          agent('Nobody left behind. Nobody left over.'),
        ],
      },
      {
        id: 'drive',
        tab: 'night shift',
        lines: [
          user('going to sleep. PRs are yours.'),
          agent('One supervisor, one heartbeat. No babysitting loop in this session.'),
          bash('bro review watch install --every 300'),
          bash('nohup bro review drive --every 300 >> drive.log 2>&1 &'),
          hook('PostToolUse · bro comms notify: watch — PR #57 blocked · open_threads, no owner'),
          user('morning. what happened?'),
          bash('bro review watch --once'),
          out('  #57  ok'),
          out('  #58  blocked — open_threads · fixer running'),
          bash('tail -1 drive.log'),
          out('drive: PR #57 merged via bro review act merge · worktree retired'),
          agent('Nothing merged around the gate. #58 is still being argued with.'),
        ],
      },
    ],
  },
  {
    id: 'review',
    label: 'review',
    gist: 'done is a verdict, not a vibe. merged is not done either.',
    scenarios: [
      {
        id: 'act',
        tab: '"it\'s done, trust me"',
        lines: [
          user('ship it'),
          agent('Done! All tests pass and the PR is ready. 🎉'),
          hook('Stop hook · bro: PR #42 not done — unresolved review threads, CI still pending'),
          agent('…right. Checking.'),
          bash('bro review act threads'),
          out('src/auth.ts  "this null check does nothing"'),
          out('src/auth.ts  "why are we logging the token?"'),
          agent('Fixed both, replied, pushed. Letting the gate decide.'),
          bash('bro review act wait --merge'),
          out('exit_gate=OK — merged'),
          agent('Now it is done. For real this time.'),
        ],
      },
      {
        id: 'debt',
        tab: 'merged ≠ done',
        lines: [
          user('PR merged. we good?'),
          bash('bro review debt collect'),
          out('merged PRs swept · unresolved threads → ledger · labeled debt:collected'),
          bash('bro review debt next'),
          out('→ #88  src/cache.ts  "TTL is never refreshed"'),
          agent('Merged is not done. Fixing it in a follow-up PR.'),
          bash('bro review debt set done --thread-id T_88 --fix-pr 91'),
          out('ledger updated · bro review debt sync projects it into beads'),
          agent('bro keeps its own ledger in public. See /debt.'),
        ],
      },
      {
        id: 'judge',
        tab: 'second opinion',
        lines: [
          user('twelve review comments. which ones matter?'),
          bash('bro review act threads'),
          out('src/api.ts  "rename this variable"'),
          out('  judge: blocks_correctness 0.04 · severity 0.2/4 (cosmetic) · action reply'),
          out('src/api.ts  "two writers race on the same key"'),
          out('  judge: blocks_correctness 0.93 · severity 2.9/4 (blocking) · action resolve'),
          agent('Fixing the race. The nit gets a reply, not a rewrite.'),
          user('do we trust the judge?'),
          bash('bro self judge stats'),
          out('agreement vs recorded outcome · latency · cost per decision'),
          agent('Shadow mode: it annotates, the gate still decides.'),
        ],
      },
      {
        id: 'guard',
        tab: 'house rules',
        lines: [
          user('quick fix in core, ship it'),
          agent('Patched packages/core/src — special-cased devin right there.'),
          hook('Stop hook · bro self guard core-vendor-boundary: vendor name in packages/core — move it to a connector'),
          agent('House rule. Moving it to a connector.'),
          bash('bro self guard test core-vendor-boundary'),
          out('SKIP · diff ✓ · probe core-vendor ✗ · budget ok'),
          agent('The rule lives in bro.config.json — not in my memory, not in a prompt.'),
        ],
      },
    ],
  },
  {
    id: 'reflection',
    label: 'self-reflection',
    gist: 'vent, descend, remember. the next session starts smarter.',
    scenarios: [
      {
        id: 'wtf',
        tab: '"bro, wtf"',
        lines: [
          user('bro wtf. you deleted the migrations folder'),
          bash('bro wtf "you deleted the migrations folder"'),
          out('complaint captured verbatim · git snapshot attached'),
          agent("I'm so sorry, it won't happen ag—"),
          hook('Stop hook · bro: a wtf is unanswered — a retro is owed, not an apology'),
          bash('bro self retrospect record retro.toml'),
          out('retro recorded · prevention: "never rm -rf outside the build dir"'),
          agent('Retro filed. The prevention is a task now, not a promise.'),
        ],
      },
      {
        id: 'drill',
        tab: 'rabbit hole',
        lines: [
          user('why is CI red?'),
          bash('bro work drill down "why is CI red"'),
          bash('bro work drill down "why does the lockfile differ"'),
          agent('Found it: the CI image ships a different npm.'),
          agent('While I am here, let me rewrite the build system in Rust—'),
          hook('Stop hook · bro: open drill frame "why does the lockfile differ" — come back with a --result'),
          agent('…fair.'),
          bash('bro work drill up --result "npm mismatch in CI" --prevent "pin npm"'),
          out('frame closed · follow-up task created'),
          agent('Back on the surface: one cause, one fix, one follow-up.'),
        ],
      },
      {
        id: 'learn',
        tab: 'déjà vu',
        lines: [
          user('tests pass locally, ship it?'),
          hook('UserPromptSubmit · bro self learn: "run the exact CI command, not a hand-picked runner"'),
          agent('Fool me once. Running what CI runs, not my favourite runner.'),
          bash('npm test'),
          out('1 failing — the same one CI saw last time'),
          agent('Lesson 1, local runner 0. Fixing it before I claim anything.'),
          user('wait, does bro know why the e2e flakes?'),
          bash('bro self learn probe "e2e flakes on CI only"'),
          out('miss · gap recorded — answer it once, it fires next time'),
        ],
      },
      {
        id: 'retro',
        tab: 'retro',
        lines: [
          agent('All done. PR merged, tree clean.'),
          hook('Stop hook · bro self guard retro-on-stop: session ending — run the retro checklist'),
          agent('Retro. I hand-rolled a script to prune agents.json. Again.'),
          bash('bro task new "gap: bro fleet agents prune"'),
          out('bro-k7a1 created'),
          bash('bro self learn capture --dry-run'),
          out('1 lesson · trigger: post-tool on agents.json edits'),
          agent('Next week that script is a command.'),
          bash('bro fleet agents prune'),
          out('terminal entries reaped'),
          agent('It is. bro writes bro.'),
        ],
      },
    ],
  },
]
