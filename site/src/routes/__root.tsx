import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'
import DefaultSearchDialog from '../components/search'

const title = 'bro — every agent needs a bro'
const description =
  'A hook system that organizes and orchestrates tasks for any agent. Install the plugin — your agent gets a bro.'

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
    links: [{ rel: 'icon', href: `${import.meta.env.BASE_URL}favicon.svg`, type: 'image/svg+xml' }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <RootProvider
          theme={{ forcedTheme: 'dark', enableSystem: false }}
          search={{ SearchDialog: DefaultSearchDialog }}
        >
          {children}
        </RootProvider>
        <Scripts />
      </body>
    </html>
  )
}
