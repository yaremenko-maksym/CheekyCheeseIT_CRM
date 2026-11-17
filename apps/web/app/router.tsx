import { createRouter as createTanStackRouter, type ParsedLocation } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { NotFound } from './components/not-found'
import { navigationContext } from './lib/router-context'

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // AC6: styled catch-all for unknown routes — replaces the framework's
    // bare «Not Found» text with an app-styled empty state.
    defaultNotFoundComponent: NotFound,
    // `_authenticated`'s beforeLoad tells a real load from a hover preload (PR #1330 SR-M-1).
    context: navigationContext((): { latestLocation: ParsedLocation } => router),
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
