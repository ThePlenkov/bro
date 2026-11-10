import type { ReactNode } from 'react';

export function ProductPage({
  eyebrow,
  title,
  intro,
  children,
}: Readonly<{
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}>) {
  return (
    <main className="toolkit-page">
      <section className="hero">
        <p className="kicker">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lede">{intro}</p>
      </section>
      {children}
      <footer className="product-foot">
        <a href={`${import.meta.env.BASE_URL}docs`}>Read the docs →</a>
        <span>MIT · your agents, your systems.</span>
      </footer>
    </main>
  );
}
