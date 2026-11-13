import { createFileRoute } from '@tanstack/react-router';
import { Dogfood } from '../components/Dogfood';
import { InstallSection } from '../components/Install';
import { ProductPage } from '../components/ProductPage';
import { Terminal } from '../components/Terminal';
import css from '../styles.css?url';

export const Route = createFileRoute('/cli')({
  head: () => ({
    meta: [{ title: 'bro CLI — deterministic lifecycle closure' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Cli,
});

const pieces = [
  { name: 'cli', what: 'bro', gloss: 'the mechanics your prompts kept forgetting.' },
  { name: 'plugins', what: 'every agent', gloss: 'same bro inside every client you use.' },
  { name: 'hooks', what: 'the lifecycle', gloss: 'rehydrate, nudge, gate the stop. fail-open.' },
  { name: 'skills', what: 'the policy', gloss: 'when to call bro, never how.' },
  { name: 'connectors', what: 'your systems', gloss: 'beads, GitHub, GitLab, Jira, tmux, ACP.' },
];

function Cli() {
  return (
    <ProductPage
      eyebrow="01 / bro CLI"
      title="Done is a verdict, not a vibe."
      intro="task → agent → PR → gate → debt. bro drives the review gate to merge and sweeps the debt after — with the agents you already have."
    >
      <section className="demo">
        <Terminal />
        <p className="caption">real commands, dramatized agents.</p>
      </section>
      <div className="feature-grid">
        <section className="feature-section">
          <h2>The gate.</h2>
          <p>
            One read, one verdict: <code>threads=0 ci=0 reviewers=0 sast=0</code>. That's what
            "ready to merge" means when bro says it.
          </p>
        </section>
        <section className="feature-section">
          <h2>The debt.</h2>
          <p>
            Merged still isn't done. Reviewers' leftovers land in a ledger instead of rotting in
            closed tabs. <a href={`${import.meta.env.BASE_URL}debt`}>Ours is live →</a>
          </p>
        </section>
        <section className="feature-section">
          <h2>No token bonfire.</h2>
          <p>
            Long waits go to a background shell — <code>bro review act wait</code> — not a subagent.
            Zero tokens while the gate settles. <strong>Gates, not loops.</strong>
          </p>
        </section>
      </div>
      <section className="how">
        <h2>And when one agent isn't enough</h2>
        <ol className="pieces">
          {pieces.map(p => (
            <li key={p.name}>
              <span className="piece-name">{p.name}</span>
              <span className="piece-what">{p.what}</span>
              <p>{p.gloss}</p>
            </li>
          ))}
        </ol>
      </section>
      <Dogfood />
      <InstallSection />
    </ProductPage>
  );
}
