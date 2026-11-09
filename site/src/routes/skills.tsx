import { createFileRoute } from '@tanstack/react-router';
import { ProductPage } from '../components/ProductPage';
import css from '../styles.css?url';

export const Route = createFileRoute('/skills')({
  head: () => ({
    meta: [{ title: 'bro skill system — policy that travels' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Skills,
});

function Skills() {
  return (
    <ProductPage
      eyebrow="02 / bro skill system"
      title="Policy that travels."
      intro="Skills say when and why. The CLI owns how. Stop copying workflow mechanics into prompts."
    >
      <section className="feature-section">
        <h2>Markdown policy. Executable mechanics.</h2>
        <p>
          Each Agent Skill lives in <code>skills/&lt;name&gt;/SKILL.md</code>. Act, debt, drill,
          SDD, retro — thin policy wrappers over CLI commands, not another implementation.
        </p>
        <a href={`${import.meta.env.BASE_URL}docs/skills`}>Explore the skills →</a>
      </section>
      <section className="feature-section">
        <h2>Hooks remember. Guard nudges.</h2>
        <p>
          Rehydrate on start, contribute context on prompt, check completion on stop. Hooks carry
          enforcement; declarative guard rules contribute scoped nudges, never their own hard gate.
          Hooks fail open; the CLI carries the verdict.
        </p>
      </section>
      <section className="feature-section">
        <h2>Packs in. Lock what you install.</h2>
        <p>
          <code>@broject/bro-pack</code> carries the default skills and formulas, installed through{' '}
          <code>bro setup --pack</code>. The skills lock records installed source provenance. Your
          repo can carry its own policy without forking the mechanics.
        </p>
        <a href={`${import.meta.env.BASE_URL}docs/reference/skills`}>Skills and lock reference →</a>
      </section>
    </ProductPage>
  );
}
