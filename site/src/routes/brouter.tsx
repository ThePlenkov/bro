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
      intro="The direction: an independent AI-native task router for your real configured agents. Not an LLM request router — bifrost handles that layer."
    >
      <section className="feature-section">
        <span className="status beta">beta / source-built CLI</span>
        <h2>A CLI of its own.</h2>
        <p>
          <code>@broject/brouter</code> exports a standalone <code>brouter</code> binary. It does
          not depend on the bro CLI package. Today's surfaces include model catalogs, client
          adapters, route-table validation and agent calls. The table is TOML today, not the planned
          MD formula.
        </p>
        <p>The standalone package is not published on npm yet. From a built checkout:</p>
        <pre className="code-block">node packages/brouter/dist/cli.js --help</pre>
        <p>
          Agent calls need configured providers; catalog and client commands need a running router
          endpoint. Standalone packaging does not mean every command is zero-configuration.
        </p>
        <a href="https://github.com/ThePlenkov/bro/tree/main/packages/brouter">
          Inspect the package →
        </a>
      </section>
      <section className="feature-section planned-panel">
        <span className="status planned">planned / task-routing direction</span>
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
        <p>Outcomes feedback, recall and formula scoring are planned work, not shipped promises.</p>
      </section>
      <section className="feature-section">
        <span className="status planned">planned / benchmark</span>
        <h2>Prove the lift.</h2>
        <p>
          One prompt, bare agent versus agent + bro. Measure the workflow's contribution separately
          from router replay quality. The benchmark is planned; there are no published lift numbers
          to sell you.
        </p>
        <a href="https://github.com/ThePlenkov/bro/blob/main/specs/bro-0ykhg.md">
          Read the task-router roadmap →
        </a>
      </section>
    </ProductPage>
  );
}
