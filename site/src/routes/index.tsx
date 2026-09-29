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
  { name: 'plugin', what: 'skills + hooks', gloss: 'lives inside your agent. rehydrates context on start, blocks the stop while work is unfinished.' },
  { name: 'bro', what: 'one CLI', gloss: 'the mechanics your prompts kept forgetting. one command, one verdict.' },
  { name: 'connectors', what: 'your systems', gloss: 'beads, GitHub, and whatever you plug in next — behind the same facades.' },
]

const vocab = [
  ['bro wtf', 'log the frustration. verbatim. with receipts.'],
  ['bro drill', 'go deeper. you must come back with a result.'],
  ['bro act', 'done? prove it. threads, checks, mergeable.'],
  ['bro debt', 'merged PRs still owe you. bro collects.'],
  ['bro next', 'what now? bro picks. you ship.'],
  ['bro loop', 'fine, bro drives. you review.'],
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
            Every agent needs a <em>bro</em>.
          </h1>
          <p className="lede">
            bro is a hook system that organizes and orchestrates tasks for any agent. Install the plugin —
            Claude, Codex or Devin calls <code>bro</code> and stops forgetting, faking "done", and wandering off.
          </p>
          <Install />
        </section>

        <section className="demo">
          <Terminal />
          <p className="caption">real commands, dramatized agents.</p>
        </section>

        <section className="how">
          <h2>How it works</h2>
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

        <section className="not">
          <h2>Not another orchestrator</h2>
          <p>
            No swarm. No extra sessions. No token bonfire. Your agent keeps its own session — bro hooks into its
            lifecycle and keeps it honest. <strong>Gates, not loops.</strong>
          </p>
        </section>

        <section className="vocab">
          <h2>The whole vocabulary</h2>
          <dl>
            {vocab.map(([cmd, gloss]) => (
              <div key={cmd}>
                <dt>{cmd}</dt>
                <dd>{gloss}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="foot">
        <p>bro doesn't fix your code. bro makes sure it gets fixed.</p>
        <p className="links">
          <a href={GITHUB}>github</a> · <a href="https://www.npmjs.com/package/@broject/bro">npm</a> ·{' '}
          <a href={DOCS}>docs</a> · MIT
        </p>
      </footer>
    </>
  )
}
