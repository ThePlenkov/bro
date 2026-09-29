import { llms, loader } from 'fumadocs-core/source'
import { defineDocs } from 'fumadocs-mdx/macro'

export const docs = defineDocs({
  dir: 'content/docs',
  docs: { async: true, postprocess: { includeProcessedMarkdown: true } },
})

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: '/docs',
})

export const docsLlms = llms(source, {
  renderPage: async (page) => {
    const baseUrl = import.meta.env.BASE_URL
    const content = (await page.data.getText('processed')).replaceAll('](/docs', `](${baseUrl}docs`)
    return `# ${page.data.title} (${baseUrl}${page.url.slice(1)})\n\n${content}`
  },
})
