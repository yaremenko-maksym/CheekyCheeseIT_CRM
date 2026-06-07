import { QueryClient } from '@tanstack/react-query'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60, // 1 min
        // gcTime must be >= persister maxAge (24 h) so the in-memory cache does
        // not evict entries before PersistQueryClientProvider can dehydrate them.
        gcTime: 24 * 60 * 60 * 1000, // 24 hours
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  })
}
