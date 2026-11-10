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

The hub links `/cli`, `/skills`, `/plugins`, `/brouter` and `/marketplace`.
The root shell owns navigation and the work-in-progress banner, including
on docs and debt. Vite's `bro-marketplace` plugin builds a virtual catalog
from public `packages/*/package.json` metadata; private packages are excluded.
`planned-connectors.json` is only for unpackaged plans. Run
`npm --prefix .. run check:docs` to check metadata with the same validator.
