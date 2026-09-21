import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://theplenkov.github.io',
  base: '/bro',
  integrations: [
    starlight({
      title: 'bro',
      description: "Your agent's sidekick — skills are instructions, bro is the hands.",
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ThePlenkov/bro' },
        { icon: 'external', label: 'npm', href: 'https://www.npmjs.com/package/@theplenkov/bro' },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Start here', items: ['getting-started', 'why-bro'] },
        {
          label: 'Commands',
          items: [
            'commands/debt',
            'commands/act',
            'commands/drill',
            'commands/retrospect',
            'commands/utility',
          ],
        },
        {
          label: 'Guides',
          items: ['configuration', 'plans', 'integrations', 'skills'],
        },
        { label: 'Extend', items: ['plugins'] },
      ],
    }),
  ],
})
