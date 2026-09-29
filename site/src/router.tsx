import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

const BASE_URL = import.meta.env.BASE_URL

// staticFunctionMiddleware fetches a root-relative /__tsr/ cache URL, ignoring the base path
if (import.meta.env.PROD && typeof window !== 'undefined') {
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, init) =>
    nativeFetch(
      typeof input === 'string' && input.startsWith('/__tsr/')
        ? `${BASE_URL}${input.slice(1)}`
        : input,
      init,
    )
}

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, basepath: BASE_URL })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
