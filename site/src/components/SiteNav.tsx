const base = import.meta.env.BASE_URL;

export const products = [
  {
    path: 'cli',
    name: 'bro CLI',
    tag: '01 / close the loop',
    description:
      'Task → agent → PR → gate → debt. Deterministic lifecycle closure, with your existing agents.',
  },
  {
    path: 'skills',
    name: 'bro skill system',
    tag: '02 / carry the policy',
    description: 'Agent Skills, hooks and guard. Policy in Markdown. Mechanics in the CLI.',
  },
  {
    path: 'plugins',
    name: 'bro agent plugins',
    tag: '03 / meet your client',
    description: 'One portable Agent Plugin. Packaged for the clients you already use.',
  },
  {
    path: 'brouter',
    name: 'brouter',
    tag: '04 / route the task',
    description:
      'An independent AI-native task router. Your Markdown formulas, your configured agents, feedback from real outcomes.',
  },
] as const;

export function SiteNav() {
  return (
    <header className="toolkit-nav">
      <a className="toolkit-logo" href={base}>
        bro <span aria-hidden="true">_</span>
      </a>
      <nav aria-label="Main navigation">
        <details className="product-menu">
          <summary>products</summary>
          <div>
            {products.map(product => (
              <a key={product.path} href={`${base}${product.path}`}>
                {product.name}
              </a>
            ))}
          </div>
        </details>
        <a href={`${base}marketplace`}>marketplace</a>
        <a href={`${base}docs`}>docs</a>
        <a href="https://github.com/ThePlenkov/bro">github ↗</a>
      </nav>
    </header>
  );
}
