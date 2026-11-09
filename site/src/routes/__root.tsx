import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import DefaultSearchDialog from '../components/search';
import { SiteNav } from '../components/SiteNav';
import shellCss from '../styles/shell.css?url';

const title = 'bro — toolkit for agent workflows';
const description =
  'bro stays the core. Connect your agents, carry the policy, close the lifecycle. CLI, skills, portable agent plugins and brouter.';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { name: 'theme-color', content: '#0a0c0b' },
    ],
    links: [
      { rel: 'icon', href: `${import.meta.env.BASE_URL}favicon.svg`, type: 'image/svg+xml' },
      { rel: 'stylesheet', href: shellCss },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="toolkit-shell">
          <aside className="wip-banner" aria-label="Project status">
            <strong>Work in progress</strong>
            <span>Interfaces evolve. Planned means not shipped.</span>
          </aside>
          <SiteNav />
        </div>
        <RootProvider
          theme={{ forcedTheme: 'dark', enableSystem: false }}
          search={{ SearchDialog: DefaultSearchDialog }}
        >
          {children}
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
