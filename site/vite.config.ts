import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { buildCatalog } from './catalog.ts';

export default defineConfig({
  plugins: [
    {
      name: 'bro-marketplace',
      resolveId: id => (id === 'virtual:bro-catalog' ? '\0virtual:bro-catalog' : undefined),
      load: id =>
        id === '\0virtual:bro-catalog'
          ? `export default ${JSON.stringify(buildCatalog())}`
          : undefined,
    },
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [
        ...['/', '/cli', '/skills', '/plugins', '/brouter', '/marketplace', '/debt'].map(path => ({
          path,
        })),
        { path: '/docs' },
        { path: '/api/search' },
        { path: '/llms.txt' },
        { path: '/llms-full.txt' },
      ],
    }),
    react(),
  ],
});
