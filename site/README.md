# bro site

Landing page and docs for [bro](https://github.com/ThePlenkov/bro).

TanStack Start (React) + Vite, prerendered to static HTML. Docs live in `content/docs/`; command references are under `content/docs/commands/`. Their sidebar is configured in `meta.json`.

Deployed from `main` to Cloudflare Workers at [broject.dev](https://broject.dev) by [`.github/workflows/site.yml`](../.github/workflows/site.yml); requires repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

```bash
npm ci --ignore-scripts
npm run dev        # http://localhost:3000/
npm run build      # static output in dist/client
npm run preview
npm run typecheck
```

Edit the agent-terminal use cases in `src/scenarios.ts`.
