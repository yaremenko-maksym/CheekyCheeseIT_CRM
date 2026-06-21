import { createContext, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient, useIsRestoring } from '@tanstack/react-query'
import { del as idbDel } from 'idb-keyval'
import type { SessionUser } from '@crm/shared'
import { api } from '../lib/axios'
import { PERSIST_KEY } from '../lib/persister'

interface AuthContextValue {
  user: SessionUser | null
  isLoading: boolean
  invalidate: () => void
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  invalidate: () => {},
})

async function fetchMe(): Promise<SessionUser | null> {
  const res = await api.get<SessionUser>('/auth/me', {
    validateStatus: (status) => status === 200 || status === 401,
  })
  if (res.status !== 200) {
    // Session expired / unauthenticated — purge any persisted query cache so a
    // stale user's data can't linger in IndexedDB after a 401 (security review
    // PR #140: clear on session-expiry, not only on explicit logout). Best-effort.
    void idbDel(PERSIST_KEY).catch(() => {})
    return null
  }
  // API already validates shape via JWT — trust the response and cast directly
  return res.data
}

export function AuthProvider({ children, skip }: { children: ReactNode; skip?: boolean }) {
  const queryClient = useQueryClient()

  // isRestoring is true while PersistQueryClientProvider is rehydrating the
  // IndexedDB cache.  During this window the ['auth','me'] query has
  // status:'pending'/fetchStatus:'idle' (not yet fetched) — if we treated
  // isLoading=false + data=undefined as "no user", CrmLayout would redirect
  // to /login before the real /api/auth/me response arrives.
  //
  // Fix (Option A — centralised): expose isRestoring via isLoading so every
  // consumer (CrmLayout guard, etc.) automatically waits for the restore to
  // complete without any changes at the call-site.
  const isRestoring = useIsRestoring()

  const { data, isPending, isFetching } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: fetchMe,
    enabled: typeof window !== 'undefined' && !skip,
    retry: false,
    staleTime: 5 * 60 * 1000,
    ...(skip ? { initialData: null } : {}),
  })

  // isLoading = true while IndexedDB is being restored OR while the auth
  // query is in-flight.  This prevents the guard from seeing user=null
  // prematurely during the restore window.
  const isLoading = isRestoring || (isPending && isFetching)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })

  return (
    <AuthContext.Provider value={{ user: data ?? null, isLoading, invalidate }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
