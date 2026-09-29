import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  const baseUrl = import.meta.env.BASE_URL

  return {
    nav: {
      title: (props) => (
        <a {...props} href={baseUrl}>
          bro <span aria-hidden="true">🤝</span>
        </a>
      ),
      url: baseUrl,
    },
    githubUrl: 'https://github.com/ThePlenkov/bro',
    links: [{ text: 'npm', url: 'https://www.npmjs.com/package/@broject/bro', external: true }],
    themeSwitch: { enabled: false },
  }
}
