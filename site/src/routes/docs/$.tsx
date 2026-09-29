import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions'
import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import { Suspense, use } from 'react'
import { useMDXComponents } from '../../components/mdx'
import { baseOptions } from '../../lib/layout.shared'
import { docs, source } from '../../lib/source'
import css from '../../styles/docs.css?url'

export const Route = createFileRoute('/docs/$')({
  head: () => ({ links: [{ rel: 'stylesheet', href: css }] }),
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split('/') ?? []
    const data = await serverLoader({ data: slugs })
    await docs.getPage(data.path)?.preload()
    return data
  },
})

const serverLoader = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs)
    if (!page) throw notFound()

    return {
      path: page.path,
      pageTree: await source.serializePageTree(source.getPageTree()),
    }
  })

function Content({ path }: { path: string }) {
  const page = docs.getPage(path)
  if (!page) throw new Error(`unknown page: ${path}`)

  const { toc } = use(page.load())
  const MDX = page.body

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

function Page() {
  const { pageTree, path } = useFumadocsLoader(Route.useLoaderData())

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Suspense>
        <Content path={path} />
      </Suspense>
    </DocsLayout>
  )
}
