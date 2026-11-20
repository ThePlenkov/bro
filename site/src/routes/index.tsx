import { createFileRoute } from '@tanstack/react-router';
import { products } from '../components/SiteNav';
import { Dogfood } from '../components/Dogfood';
import css from '../styles.css?url';

export const Route = createFileRoute('/')({
  head: () => ({ links: [{ rel: 'stylesheet', href: css }] }),
  component: Home,
});

function Home() {
  const base = import.meta.env.BASE_URL;
  return (
    <main className="toolkit-page">
      <section className="hero hub-hero">
        <p className="kicker">
          <span className="live-dot" /> your agents. your systems. your workflow.
        </p>
        <h1>
          A toolkit for
          <br />
          <em>agent workflows.</em>
        </h1>
        <p className="lede">
          bro stays the core. Everything else is a connector.
          <br />
          Close the loop, carry the policy, bring your own agents.
        </p>
        <p className="lede">
          <strong>ICP:</strong> maintainers and small teams with existing agents, a task store, and
          PR/CI. <strong>JTBD:</strong> deterministic lifecycle closure — `task → agent → PR → gate → debt`.{' '}
          <strong>Wedge:</strong> portable `task → agent → PR → gate → debt` contract. Start with the
          review gate and debt ledger — no fleet, no model-gateway required. Orchestration
          (fleet/convoy/loop) is optional and progressive, not a replacement runtime.
        </p>
        <p className="lede">
          <strong>ICP:</strong> maintainers and small teams with existing agents, a task store, and
          PR/CI. <strong>JTBD:</strong> deterministic lifecycle closure — `task → agent → PR → gate → debt`.{' '}
          <strong>Wedge:</strong> portable `task → agent → PR → gate → debt` contract. Start with the
          review gate and debt ledger — no fleet, no model-gateway required. Orchestration
          (fleet/convoy/loop) is optional and progressive, not a replacement runtime.
        </p>
        <div className="hero-actions">
          <a className="button-primary" href={`${base}cli`}>
            Start with the CLI →
          </a>
          <a href={`${base}marketplace`}>Explore the marketplace ↗</a>
        </div>
      </section>
      <section className="product-section" id="scenario">
        <div className="section-heading">
          <h2>End-to-end scenario (no fleet/model gateway required)</h2>
          <span>task → agent → PR → gate → debt</span>
        </div>
        <pre className="code-block">{`# 1) Claim work from your task store
npx @broject/bro next
BEAD="<bead-id>"

# 2) Implement and open a PR
git add -A
git commit -m "$BEAD: <summary>"
git push -u origin HEAD
gh pr create --fill

# 3) Drive the PR through the review gate
npx @broject/bro act status
npx @broject/bro act threads
npx @broject/bro act merge --bead "$BEAD"

# 4) Sweep merged threads into debt
npx @broject/bro debt prs
npx @broject/bro debt collect
npx @broject/bro debt status
npx @broject/bro debt next`}</pre>
      </section>
      <section className="product-section" id="scenario">
        <div className="section-heading">
          <h2>End-to-end scenario (no fleet/model gateway required)</h2>
          <span>task → agent → PR → gate → debt</span>
        </div>
        <pre className="code-block">
{`# 1) Claim work from your task store
npx @broject/bro next
BEAD="<bead-id>"  # replace <bead-id> with the ID from the claimed work order

# 2) Implement and open a PR for the claimed work
git add -A
git commit -m "$BEAD: <summary>"
git push -u origin HEAD
gh pr create --fill

# 3) Drive the PR through the review gate
npx @broject/bro act status
npx @broject/bro act threads
npx @broject/bro act merge --bead "$BEAD"

# 4) Sweep merged threads into debt
npx @broject/bro debt prs
npx @broject/bro debt collect
npx @broject/bro debt status
npx @broject/bro debt next`}
        </pre>
      </section>
      <section className="product-section" id="products">
        <div className="section-heading">
          <h2>Ways in.</h2>
          <span>Use what you need. Leave the rest.</span>
        </div>
        <div className="product-grid">
          {products.map(product => (
            <a className="product-card" href={`${base}${product.path}`} key={product.path}>
              <span className="kicker">{product.tag}</span>
              <h3>
                {product.name}
                <span aria-hidden="true">↗</span>
              </h3>
              <p>{product.description}</p>
              <span className="card-link">Explore the product →</span>
            </a>
          ))}
        </div>
      </section>
      <section className="marketplace-strip">
        <div>
          <p className="kicker">connect, don't rebuild</p>
          <h2>Your stack belongs here.</h2>
          <p>
            Tasks, reviews, agents, judges, telemetry. Connectors at the edge. Capabilities on the
            core.
          </p>
        </div>
        <a href={`${base}marketplace`}>Browse marketplace →</a>
      </section>
      <Dogfood />
      <footer className="product-foot">
        <span>bro doesn't fix your code. bro makes sure it gets fixed.</span>
        <a href={`${base}docs`}>Read the docs →</a>
      </footer>
    </main>
  );
}
