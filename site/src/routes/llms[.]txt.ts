import { createFileRoute } from '@tanstack/react-router'
import { docsLlms } from '../lib/source'

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: async () => {
        const index = await docsLlms.index()
        return new Response(index.replaceAll('](/docs', `](${import.meta.env.BASE_URL}docs`))
      },
    },
  },
})
