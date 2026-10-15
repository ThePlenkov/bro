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
            Your agent opened a PR.
            <br />
            Who merges it?
          </h1>
          <p className="lede">
            Not you. bro drives it — watches the review gate, answers the threads, fixes the findings, merges on
            green, and sweeps the debt after. <em>Done is a verdict, not a vibe.</em>
          </p>
          <Install />
        </section>

        <section className="demo">
          <Terminal />
          <p className="caption">real commands, dramatized agents.</p>
        </section>

        <section className="self">
          <h2>The gate is the product</h2>
          <p>
            One read, one verdict: <code>threads=0 ci=0 reviewers=0 sast=0</code> — that's what "ready to merge"
            means when bro says it. And merged still isn't done: reviewers' leftovers land in a public ledger
            instead of rotting in closed tabs. bro sweeps its own merged PRs —{' '}
            <a href={`${BASE_URL}debt`}>the debt ledger is live</a>.
          </p>
        </section>

        <section className="how">
          <h2>And when one agent isn't enough</h2>
          <ol className="pieces">
            {pieces.map((p) => (
              <li key={p.name}>
                <span className="piece-name">{p.name}</span>
                <span className="piece-what">{p.what}</span>
                <p>{p.gloss}</p>
              </li>
            ))}
          </ol>
          <p>
            Fine, it orchestrates now. Still no swarm by default, no token bonfire. Your agent keeps its own
            session — bro hooks into its lifecycle and keeps it honest. When you do want many agents, one facade
            spawns them — native processes, tmux panes, Gas City, ACP providers — under a fleet cap, and they
            reach you through a mailbox, not a wait loop. Long waits go to a background shell —{' '}
            <code>bro review act wait</code>, <code>bro review watch</code> — not even a subagent: zero tokens
            while the gate settles, and your agent keeps working. <strong>Gates, not loops.</strong>
          </p>
        </section>

        <section className="not">
          <h2>bro writes bro</h2>
          <p>
            Agents claim beads, ship through the act gate, sweep their own review debt, and turn retros into the
            next beads — a hand-rolled script today is a <code>bro</code> command next week. This site, the CLI,
            and most of the merged PRs were built that way.
          </p>
          <p>
            The whole vocabulary — <code>bead</code>, <code>mol</code>, <code>convoy</code>, <code>act</code>,{' '}
            <code>drill</code>, <code>wtf</code> — lives in the <a href={`${DOCS}/glossary`}>glossary</a>, not on
            a landing page that rots against the CLI.
          </p>
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
