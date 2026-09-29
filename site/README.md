# bro site

Landing page and docs for [bro](https://github.com/ThePlenkov/bro), hosted at https://theplenkov.github.io/bro/.

TanStack Start (React) + Vite, prerendered to static HTML. Docs live in `content/docs/`; their sidebar is configured in `meta.json`.

```bash
npm ci --ignore-scripts
npm run dev        # http://localhost:3000/bro/
npm run build      # static output in dist/client
npm run preview
npm run typecheck
```

Edit the agent-terminal use cases in `src/scenarios.ts`.
