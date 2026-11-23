import { createFileRoute } from '@tanstack/react-router';
import { Install } from '../components/Install';
import { Terminal } from '../components/Terminal';
import css from '../styles.css?url';

export const Route = createFileRoute('/cli')({
  head: () => ({
    meta: [{ title: 'bro CLI — deterministic lifecycle closure' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Home,
});

const GITHUB = 'https://github.com/ThePlenkov/bro';
const BASE_URL = import.meta.env.BASE_URL;
const DOCS = `${BASE_URL}docs`;

const pieces = [
  {
    name: 'cli',
    what: 'bro',
    gloss: 'the mechanics your prompts kept forgetting. one command, one verdict.',
  },
  {
    name: 'plugins',
    what: 'every agent',
    gloss: 'Claude, Codex, Cursor, Devin, OpenCode, Kilo, pi — same bro inside.',
  },
  {
    name: 'hooks',
    what: 'the lifecycle',
    gloss: 'rehydrate on start, nudge on prompt, gate the stop. always fail-open.',
  },
  {
    name: 'skills',
    what: 'the policy',
    gloss: 'thin wrappers: when to call bro, never how. the how lives in code.',
  },
  {
    name: 'connectors',
    what: 'your systems',
    gloss:
      'tasks, reviews, agents, models, events — beads, GitHub, GitLab, Jira, tmux, Gas City, ACP.',
  },
];

function Home() {
  return (
    <>
      <main>
        <CliHero />
        <section className="demo">
          <Terminal />
          <p className="caption">real commands, dramatized agents.</p>
        </section>
        <Wedge />
        <Scenario />
        <OptionalOrchestration />
        <Dogfood />
      </main>
      <footer className="foot">
        <p>bro doesn't fix your code. bro makes sure it gets fixed.</p>
        <p className="links">
          <a href={DOCS}>docs</a> · <a href={`${BASE_URL}debt`}>debt</a> ·{' '}
          <a href={GITHUB}>github</a> · <a href="https://www.npmjs.com/package/@broject/bro">npm</a>{' '}
          · MIT
        </p>
      </footer>
    </>
  );
}

function CliHero() {
  return (
    <section className="hero">
      <p className="kicker">bro CLI / prompt engineering peaked at "bro, wtf"</p>
      <h1>
        Deterministic lifecycle closure.
        <br />
        <span style={{ fontSize: '0.8em' }}>task → agent → PR → gate → debt</span>
      </h1>
      <p className="lede">
        <strong>ICP:</strong> maintainers and small teams with existing agents, a task store, and
        PR/CI. <strong>JTBD:</strong> deterministic lifecycle closure —{' '}
        <code>task → agent → PR → gate → debt</code>. <strong>Wedge:</strong> portable{' '}
        <code>task → agent → PR → gate → debt</code> contract. Start with the review gate and debt
        ledger — no fleet, no model-gateway required. Orchestration (fleet/convoy/loop) is optional
        and progressive, not a replacement runtime. <em>Done is a verdict, not a vibe.</em>
      </p>
      <Install />
      <pre className="code-block">
        {'npm i -g @broject/bro\n# Or run without installing\nnpx @broject/bro --help'}
      </pre>
    </section>
  );
}

function Wedge() {
  return (
    <section className="self">
      <h2>The wedge: gate + debt</h2>
      <p>
        One read, one verdict: <code>threads=0 ci=0 reviewers=0 sast=0</code> — that's what "ready
        to merge" means when bro says it. And merged still isn't done: reviewers' leftovers land in
        a public ledger instead of rotting in closed tabs. bro sweeps its own merged PRs —{' '}
        <a href={`${BASE_URL}debt`}>the debt ledger is live</a>. Start here with existing agents, a
        task store, and PR/CI — no fleet, no model-gateway configuration required.
      </p>
    </section>
  );
}

function Scenario() {
  return (
    <section className="self">
      <h2>End-to-end scenario (no fleet/model gateway required)</h2>
      <pre className="code-block">
        {`# 1) Claim work from your task store
npx @broject/bro next
BEAD="<bead-id>"  # replace <bead-id> with the ID from the claimed work order
git switch -c "work/$BEAD"  # bro next does not cut a branch — create one first

# 2) Implement and open a PR for the claimed work
git add -A
git diff --cached  # skim what's staged — intended changes only, no secrets
git commit -m "$BEAD: <summary>"
git push -u origin HEAD
gh pr create --fill  # GitHub; GitLab remotes: glab mr create — the gate inspects either

# 3) Drive the PR through the review gate
npx @broject/bro act status   # verdict: threads/ci/reviewers/sast/mergeable
npx @broject/bro act threads  # work unresolved threads
#    resolve every listed thread (e.g. bro act resolve / replies),
#    then re-check bro act status until green — the gate blocks until clean
npx @broject/bro act merge --bead "$BEAD"  # merge only when green; closes the bead

# 4) Sweep leftovers from earlier merged PRs into debt
npx @broject/bro debt prs
npx @broject/bro debt collect
npx @broject/bro debt status
npx @broject/bro debt next`}
      </pre>
    </section>
  );
}

function OptionalOrchestration() {
  return (
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
      <p>
        Fine, it orchestrates now. Still no swarm by default, no token bonfire. Your agent keeps its
        own session — bro hooks into its lifecycle and keeps it honest. When you do want many
        agents, one facade spawns them — native processes, tmux panes, Gas City, ACP providers —
        under a fleet cap, and they reach you through a mailbox, not a wait loop. Long waits go to a
        background shell — <code>bro review act wait</code>, <code>bro review watch</code> — not
        even a subagent: zero tokens while the gate settles, and your agent keeps working.{' '}
        <strong>Gates, not loops.</strong>
      </p>
    </section>
  );
}

function Dogfood() {
  return (
    <section className="not">
      <h2>bro writes bro</h2>
      <p>
        Agents claim beads, ship through the act gate, sweep their own review debt, and turn retros
        into the next beads — repeated workflow steps become <code>bro</code> commands. This site,
        the CLI, and most of the merged PRs were built that way.
      </p>
      <p>
        The whole vocabulary — <code>bead</code>, <code>mol</code>, <code>convoy</code>,{' '}
        <code>act</code>, <code>drill</code>, <code>wtf</code> — lives in the{' '}
        <a href={`${DOCS}/glossary`}>glossary</a>, not on a landing page that rots against the CLI.
      </p>
    </section>
  );
}
