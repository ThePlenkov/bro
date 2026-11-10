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
        <div className="hero-actions">
          <a className="button-primary" href={`${base}cli`}>
            Start with the CLI →
          </a>
          <a href={`${base}marketplace`}>Explore the marketplace ↗</a>
        </div>
      </section>
      <section className="product-section" id="products">
        <div className="section-heading">
          <h2>Four ways in.</h2>
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
