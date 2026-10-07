import { createFileRoute } from '@tanstack/react-router'
import { Install } from '../components/Install'
import { Terminal } from '../components/Terminal'
import css from '../styles.css?url'

export const Route = createFileRoute('/')({
  head: () => ({ links: [{ rel: 'stylesheet', href: css }] }),
  component: Home,
})

const GITHUB = 'https://github.com/ThePlenkov/bro'
const BASE_URL = import.meta.env.BASE_URL
const DOCS = `${BASE_URL}docs`

const pieces = [
  { name: 'cli', what: 'bro', gloss: 'the mechanics your prompts kept forgetting. one command, one verdict.' },
  { name: 'plugins', what: 'every agent', gloss: 'Claude, Codex, Cursor, Devin, OpenCode, Kilo, pi — same bro inside.' },
  { name: 'hooks', what: 'the lifecycle', gloss: 'rehydrate on start, nudge on prompt, gate the stop. always fail-open.' },
  { name: 'skills', what: 'the policy', gloss: 'thin wrappers: when to call bro, never how. the how lives in code.' },
  {
    name: 'connectors',
    what: 'your systems',
    gloss: 'tasks, reviews, agents, models, events — beads, GitHub, GitLab, Jira, tmux, Gas City, ACP.',
  },
]

const selfLoop = ['bd ready', 'bro next', 'PR', 'bro act', 'merge', 'bro debt', 'bro retro', 'bro learn']

const vocab: Record<string, string> = {
  planning: `
next | what now? bro picks. you ship.
spec | spec before code. drift is debt, not a surprise.
stack | PRs on PRs. bro rebases the tower.
query | GitHub, GitLab, Jira — one plan, one answer.
`,
  orchestration: `
loop | fine, bro drives. you review.
convoy | a molecule of steps, run to the end.
agents | spawn, respawn, stop, prune. one facade, every backend.
fleet | who's alive, who's lost, who's over the cap.
notify | write, don't wait. lands on the next tool call.
drive | unowned review threads get a fixer. merged only on green.
watch | one heartbeat. run it in the background, keep working.
`,
  review: `
act | done? prove it. threads, checks, mergeable.
debt | merged is not done. the ledger remembers.
judge | a calibrated verdict per thread. shadow until it earns trust.
guard | house rules as config. fire on the hook, not on hope.
`,
  'self-reflection': `
wtf | log the frustration. verbatim. with receipts.
retrospect | every wtf owes a retro. every retro owes a task.
drill | go deeper. you must come back with a result.
learn | fool me once. the lesson fires next time, at the trigger.
`,
  plumbing: `
status | the whole board in one read. bro serve puts it on HTTP.
work | one worktree per agent. no checkout fights.
plugins | wire bro into OpenCode, Kilo, pi.
doctor | what's broken in your setup, before an agent finds out.
sync | ledgers on a data ref, not in your diffs.
sweep | closed beads: harvested, archived, pruned.
`,
}

const vocabGroups = Object.entries(vocab).map(([heading, text]) => ({
  heading,
  entries: text
    .trim()
    .split('\n')
    .map((row) => {
      const [cmd, gloss] = row.split(' | ')
      return [`bro ${cmd}`, gloss] as const
    }),
}))

function Home() {
  return (
    <>
      <header className="nav">
        <a className="logo" href={BASE_URL}>
          bro <span aria-hidden="true">🤝</span>
        </a>
        <nav>
          <a href={DOCS}>docs</a>
          <a href={GITHUB}>github</a>
        </nav>
      </header>

      <main>
        <section className="hero">
          <p className="kicker">prompt engineering peaked at "bro, wtf"</p>
          <h1>
            Every agent needs a <em>bro</em>.
          </h1>
          <p className="lede">
            It started as a plugin. Now it's a system: one CLI, a plugin for every agent, hooks that gate, skills
            that teach, connectors to everything you run. Your agent plans, delegates, ships, gets reviewed — and
            stops repeating the same mistake.
          </p>
          <Install />
        </section>

        <section className="demo">
          <Terminal />
          <p className="caption">real commands, dramatized agents.</p>
        </section>

        <section className="how">
          <h2>The system</h2>
          <ol className="pieces">
            {pieces.map((p) => (
              <li key={p.name}>
                <span className="piece-name">{p.name}</span>
                <span className="piece-what">{p.what}</span>
                <p>{p.gloss}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="self">
          <h2>bro writes bro</h2>
          <p className="self-loop">
            {selfLoop.map((s, i) => (
              <span key={s}>
                {i > 0 && <i aria-hidden="true"> → </i>}
                <code>{s}</code>
              </span>
            ))}
            <i aria-hidden="true"> ↺</i>
          </p>
          <p>
            bro is built with bro. Agents claim beads, ship through the act gate, sweep their own review debt, and
            turn retros into the next beads — a hand-rolled script today is a <code>bro</code> command next week.
            The <a href={`${BASE_URL}debt`}>debt ledger</a> is public.
          </p>
        </section>

        <section className="not">
          <h2>Not another orchestrator</h2>
          <p>
            Fine, it orchestrates now. Still no swarm by default, no token bonfire. Your agent keeps its own session —
            bro hooks into its lifecycle and keeps it honest. When you do want many agents, one facade spawns them —
            native processes, tmux panes, Gas City, ACP providers — under a fleet cap, and they reach you through a
            mailbox, not a wait loop. Long waits go to a background shell — <code>bro act wait</code>,{' '}
            <code>bro watch</code> — not even a subagent: zero tokens while the gate settles, and your agent keeps
            working. <strong>Gates, not loops.</strong>
          </p>
        </section>

        <section className="vocab">
          <h2>The whole vocabulary</h2>
          {vocabGroups.map((group) => (
            <div className="vocab-group" key={group.heading}>
              <h3>{group.heading}</h3>
              <dl>
                {group.entries.map(([cmd, gloss]) => (
                  <div key={cmd}>
                    <dt>{cmd}</dt>
                    <dd>{gloss}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      </main>

      <footer className="foot">
        <p>bro doesn't fix your code. bro makes sure it gets fixed.</p>
        <p className="links">
          <a href={DOCS}>docs</a> · <a href={`${BASE_URL}debt`}>debt</a> · <a href={GITHUB}>github</a> ·{' '}
          <a href="https://www.npmjs.com/package/@broject/bro">npm</a> · MIT
        </p>
      </footer>
    </>
  )
}
