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

const user = (text: string): Line => ({ kind: 'user', text })
const agent = (text: string): Line => ({ kind: 'agent', text })
const bash = (cmd: string): Line => ({ kind: 'tool', text: `Bash(${cmd})` })
const out = (text: string): Line => ({ kind: 'out', text })
const hook = (text: string): Line => ({ kind: 'hook', text })

export const scenarios: Scenario[] = [
  {
    id: 'act',
    tab: '"it\'s done, trust me"',
    lines: [
      user('ship it'),
      agent('Done! All tests pass and the PR is ready. 🎉'),
      hook('Stop hook · bro: PR #42 not done — unresolved review threads, CI still pending'),
      agent('…right. Checking.'),
      bash('bro act threads'),
      out('src/auth.ts  "this null check does nothing"'),
      out('src/auth.ts  "why are we logging the token?"'),
      agent('Fixed both, replied, pushed. Letting the gate decide.'),
      bash('bro act wait --merge'),
      out('exit_gate=OK — merged'),
      agent('Now it is done. For real this time.'),
    ],
  },
  {
    id: 'wtf',
    tab: '"bro, wtf"',
    lines: [
      user('bro wtf. you deleted the migrations folder'),
      bash('bro wtf "you deleted the migrations folder"'),
      out('complaint captured verbatim · git snapshot attached'),
      agent("I'm so sorry, it won't happen ag—"),
      hook('Stop hook · bro: a wtf is unanswered — a retro is owed, not an apology'),
      bash('bro retrospect record retro.toml'),
      out('retro recorded · prevention: "never rm -rf outside the build dir"'),
      agent('Retro filed. The prevention is a task now, not a promise.'),
    ],
  },
  {
    id: 'drill',
    tab: 'rabbit hole',
    lines: [
      user('why is CI red?'),
      bash('bro drill down "why is CI red"'),
      bash('bro drill down "why does the lockfile differ"'),
      agent('Found it: the CI image ships a different npm.'),
      agent('While I am here, let me rewrite the build system in Rust—'),
      hook('Stop hook · bro: open drill frame "why does the lockfile differ" — come back with a --result'),
      agent('…fair.'),
      bash('bro drill up --result "npm mismatch in CI" --prevent "pin npm"'),
      out('frame closed · follow-up task created'),
      agent('Back on the surface: one cause, one fix, one follow-up.'),
    ],
  },
  {
    id: 'next',
    tab: 'what now?',
    lines: [
      hook('SessionStart · bro: ready queue waiting · a merged PR still owes review debt'),
      user('what now, bro?'),
      bash('bro next'),
      out('→ claimed  "cache the avatar endpoint"'),
      out('  loop: implement → PR → bro act merge → close → bro next'),
      agent('On it. No "shall I proceed?" — the queue is the plan.'),
      user('and the debt?'),
      bash('bro debt collect'),
      out('merged PRs swept · unresolved findings land in the ledger'),
      agent('Merged is not done. Oldest finding is next in line.'),
    ],
  },
  {
    id: 'learn',
    tab: 'déjà vu',
    lines: [
      hook('UserPromptSubmit · bro: lesson — "run the exact CI command, not a hand-picked runner"'),
      user('tests pass locally, ship it?'),
      agent('Before shipping, I am checking whether the store already knows this failure.'),
      bash('bro learn probe "tests pass locally but CI fails"'),
      out('hit · run the exact CI command, not a hand-picked runner'),
      bash('npm test'),
      out('CI-shaped test command passed · the gate gets the real evidence'),
      agent('Now the local result means something. Capturing the drill finding dry-run first.'),
      bash('bro learn capture --source drill --dry-run'),
      out('lesson proposal rendered · nothing written yet'),
    ],
  },
  {
    id: 'drive',
    tab: 'night shift',
    lines: [
      user('going to sleep. PRs are yours.'),
      agent('Starting the review driver detached.'),
      bash('nohup bro drive --every 300 >> drive.log &'),
      out('driver detached · watching open PR gates'),
      hook('PostToolUse · bro notify: PR #57 had open threads — fixer spawned on its worktree'),
      bash('bro fleet'),
      out('step-57  lost — respawn?  worktree=repo--step-57  pr=#57'),
      bash('bro agents up <step>'),
      out('fixer respawned · same agentId · same worktree · same prompt'),
      agent('It can merge only through the gate: bro act merge, on green.'),
    ],
  },
]
