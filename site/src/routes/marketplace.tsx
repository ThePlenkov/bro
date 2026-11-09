import { createFileRoute } from '@tanstack/react-router';
import catalog from 'virtual:bro-catalog';
import type { CatalogEntry } from '../../catalog';
import { ProductPage } from '../components/ProductPage';
import css from '../styles.css?url';

export const Route = createFileRoute('/marketplace')({
  head: () => ({
    meta: [{ title: 'bro marketplace — connectors and capabilities' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Marketplace,
});

function Cards({ entries }: { entries: CatalogEntry[] }) {
  return (
    <div className="catalog-grid">
      {entries.map(entry => (
        <article className="catalog-card" key={entry.name}>
          <div className="catalog-card-heading">
            <h3>{entry.name}</h3>
            <span className={`status ${entry.status}`}>{entry.status}</span>
          </div>
          {entry.npm ? (
            <a className="package-name" href={`https://www.npmjs.com/package/${entry.npm}`}>
              {entry.npm} ↗
            </a>
          ) : (
            <span className="package-name">no npm package yet</span>
          )}
          <p>{entry.description}</p>
          <a
            className="card-link"
            href={`https://github.com/ThePlenkov/bro/tree/main/${entry.source}`}
          >
            Source / design ↗
          </a>
        </article>
      ))}
    </div>
  );
}

function Marketplace() {
  const connectors = catalog.filter(entry => entry.kind === 'connector');
  const facades = [...new Set(connectors.map(entry => entry.facade))].sort();
  return (
    <ProductPage
      eyebrow="marketplace / generated from the repo"
      title="Your stack. Connected."
      intro="Connectors bind your systems. Capabilities carry the workflow. This catalog is built from package metadata, not a hand-kept shopping list."
    >
      <aside className="catalog-note">
        All current public packages are labeled beta. Private packages are excluded. Planned cards
        have no separate npm package yet. <code>@broject/core</code> still contains gh/git/bd
        wrappers — this is a direction, not a claim that every boundary is already extracted.
        Package names and npm links identify the intended distribution; source presence does not
        guarantee publication on npm latest.
      </aside>
      <section className="catalog-section">
        <h2>Connectors</h2>
        <p className="section-intro">The seam is a facade. The system behind it is yours.</p>
        {facades.map(facade => (
          <section className="facade-group" key={facade}>
            <h3 className="facade-label">{facade}</h3>
            <Cards entries={connectors.filter(entry => entry.facade === facade)} />
          </section>
        ))}
        {connectors.length === 0 && <p>No connector packages yet.</p>}
      </section>
      {(['capability', 'core'] as const).map(kind => {
        const entries = catalog.filter(entry => entry.kind === kind);
        return (
          entries.length > 0 && (
            <section className="catalog-section" key={kind}>
              <h2>{kind === 'core' ? 'Core primitives' : 'Capabilities'}</h2>
              <p className="section-intro">
                {kind === 'core'
                  ? 'The shared contracts, command primitive and CLI host.'
                  : 'Workflow mechanics built on the core. Not external-system connectors.'}
              </p>
              <Cards entries={entries} />
            </section>
          )
        );
      })}
    </ProductPage>
  );
}
