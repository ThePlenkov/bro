import { createFileRoute } from '@tanstack/react-router';
import { ProductPage } from '../components/ProductPage';
import css from '../styles.css?url';

export const Route = createFileRoute('/brouter')({
  head: () => ({
    meta: [{ title: 'brouter — route the task, not the request' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Brouter,
});

function Brouter() {
  return (
    <ProductPage
      eyebrow="04 / brouter"
      title="Route the task. Not the request."
      intro="An independent AI-native task router for your real configured agents. Your Markdown formulas decide where work goes. Not an LLM request router — bifrost handles that layer."
    >
      <div className="feature-grid">
        <StandaloneCli />
        <TaskRouting />
        <Benchmark />
      </div>
      <section className="feature-section install-section" id="install">
        <h2>Install.</h2>
        <p>Inside the toolkit, or on its own.</p>
        <pre className="code-block">
          {
            'npm i -g @broject/bro\nbro router --help\n\n# or standalone\nnpm i -g @broject/brouter\nbrouter --help'
          }
        </pre>
      </section>
    </ProductPage>
  );
}

function StandaloneCli() {
  return (
    <section className="feature-section">
      <h2>A CLI of its own.</h2>
      <p>
        Use <code>bro router</code> inside the toolkit, or install <code>@broject/brouter</code>{' '}
        on its own. Standalone brouter does not require the bro CLI. Connect the agents you use,
        define the routing policy, and send each task to the right one.
      </p>
      <p>
        Route to your configured agents, not imaginary models. Keep your clients, credentials and
        working sessions. brouter makes the routing decision; the selected agent does the work.
      </p>
      <a href="https://github.com/ThePlenkov/bro/tree/main/packages/brouter">
        Inspect the package →
      </a>
    </section>
  );
}

function TaskRouting() {
  return (
    <section className="feature-section">
      <h2>You write the formula. Code keeps the rails.</h2>
      <p>
        User-authored routing formulas in Markdown describe the questions and scoring. The router
        routes tasks to the agents you configured — not imaginary models. Code owns health, chains
        and hard filters; the judge answers typed questions. Cache off by default. Unknown cost
        stays unknown.
      </p>
      <div className="routing-flow">
        <span>task</span>
        <b>→</b>
        <span>MD formula</span>
        <b>→</b>
        <span>configured agent</span>
        <b>→</b>
        <span>outcome</span>
      </div>
      <p>
        Outcome feedback closes the routing loop. Learn from completed work, compare formula choices
        against real results, and carry that evidence into the next decision.
      </p>
    </section>
  );
}

function Benchmark() {
  return (
    <section className="feature-section">
      <h2>Prove the lift.</h2>
      <p>
        One prompt, bare agent versus agent + bro. Measure the workflow's contribution separately
        from router replay quality. Compare outcomes, cost and latency on the same task, so you can
        see what the agent does alone and what bro adds.
      </p>
      <a href="https://github.com/ThePlenkov/bro/blob/main/specs/bro-0ykhg.md">
        Read the routing model →
      </a>
    </section>
  );
}
