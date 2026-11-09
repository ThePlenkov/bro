import { createFileRoute } from '@tanstack/react-router';
import { ProductPage } from '../components/ProductPage';
import { Install } from '../components/Install';
import css from '../styles.css?url';

export const Route = createFileRoute('/plugins')({
  head: () => ({
    meta: [{ title: 'bro agent plugins — one portable package' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Plugins,
});

function Plugins() {
  return (
    <ProductPage
      eyebrow="03 / bro agent plugins"
      title="Same bro. Every client."
      intro="One portable Agent Plugin: plugin.json + skills/. Client-specific packaging on top, not a separate policy tree."
    >
      <section className="feature-section">
        <h2>Bring the client you already use.</h2>
        <p>
          Claude Code, Codex, Cursor, Devin, OpenCode, Kilo and pi. Native plugin manifests or
          adapter modules carry bro into the client's lifecycle. Shared policy stays in the root
          skills tree; the client gets the hooks and packaging it needs.
        </p>
        <a href={`${import.meta.env.BASE_URL}cli`}>Installation options →</a>
        <Install />
      </section>
      <section className="feature-section">
        <h2>Agent plugins ≠ CLI extensions.</h2>
        <p>
          Agent plugins install bro into a client. CLI extensions add commands through{' '}
          <code>definePlugin</code>. Connectors bind external systems behind facades. Same core,
          distinct seams.
        </p>
        <a href={`${import.meta.env.BASE_URL}docs/plugins`}>Packaging and extension contract →</a>
      </section>
      <section className="feature-section">
        <h2>Claude Code, on top of other agents.</h2>
        <p>
          A separate plugin for using Claude Code as a CLI client over agents such as OpenCode and
          Devin. Keep Claude Code as the client while another configured agent executes the work. It
          is a separate plugin from the portable bro plugin above.
        </p>
        <a href="https://github.com/ThePlenkov/bro/blob/main/specs/bro-0ykhg.6.md">
          Read the design →
        </a>
      </section>
    </ProductPage>
  );
}
