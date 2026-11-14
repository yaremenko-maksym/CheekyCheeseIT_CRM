import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient, useIsRestoring } from '@tanstack/react-query'
import type { Query, QueryClient } from '@tanstack/react-query'
import { del as idbDel } from 'idb-keyval'
import type { Locale, SessionUser } from '@crm/shared'
import { api } from '../lib/axios'
import { PERSIST_KEY } from '../lib/persister'
import {
  activateLocale,
  clearConfirmedUserLocaleIfSettled,
  i18n,
  isLocaleConfirmedByUser,
} from '../lib/i18n'

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

const AUTH_ME_KEY = ['auth', 'me'] as const
const isAuthMe = (q: Query) => q.queryKey[0] === 'auth' && q.queryKey[1] === 'me'

/**
 * Task 7.6c: the session cookie can change under an open page (a sign-in in another tab), and the
 * cached `auth/me` user — which every scoped query key derives from — would never notice. The
 * `_authenticated` route awaits this in `beforeLoad`, so a changed user id purges every other query
 * and the persisted copy BEFORE the next route renders. A repeat of the same pathname (the click
 * after the hover preload — the router reports an active layout's preload as `preload: false`)
 * reuses the last check while it is in flight or for `REUSE_MS` after it settles; anything later
 * asks again. A check overtaken by a newer one waits for that one, so no navigation renders before
 * the newest answer is applied. Nothing before the first `auth/me` answer (AuthProvider owns that).
 */
export function createSessionRevalidator(queryClient: QueryClient) {
  const REUSE_MS = 1000 // hover preload, then click
  let last: { pathname: string; check: Promise<void>; settledAt: number | null } | null = null
  let generation = 0
  const check = async (): Promise<void> => {
    const previous = queryClient.getQueryData<SessionUser | null>(AUTH_ME_KEY)
    if (!previous) return
    // A request of its own, not a deduped `fetchQuery`: the router pushes the URL before
    // `beforeLoad` settles, so an earlier request may still be in flight under the OLD cookie.
    const mine = ++generation
    let current: SessionUser | null
    try {
      current = await fetchMe()
    } catch {
      return // network failure: keep the cache (offline use); the server still enforces access
    }
    // a later check asked after us: its answer wins, and this navigation waits for it
    if (mine !== generation) return last?.check
    // AuthProvider's own request may also predate the cookie change; its late answer must not land
    await queryClient.cancelQueries({ queryKey: AUTH_ME_KEY, exact: true })
    queryClient.setQueryData(AUTH_ME_KEY, current)
    if (current?.id === previous.id) return
    // reset, not remove: mounted observers (header, bell) drop the old data and refetch as the new user
    void queryClient.resetQueries({ predicate: (q) => !isAuthMe(q) }).catch(() => {})
    await idbDel(PERSIST_KEY).catch(() => {})
  }
  return (pathname: string): Promise<void> => {
    const fresh = last?.settledAt == null || Date.now() - last.settledAt < REUSE_MS
    if (last && last.pathname === pathname && fresh) return last.check
    const entry: NonNullable<typeof last> = { pathname, check: Promise.resolve(), settledAt: null }
    entry.check = check().finally(() => (entry.settledAt = Date.now()))
    last = entry
    return entry.check
  }
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

  // task-i18n-stage2 (Task 6): the session's own `locale` is the source of
  // truth once known — it can differ from the pre-login guess `client.tsx`
  // activated (cookie / navigator.language), e.g. a user who set their
  // profile language on one device and logs in on another with no cookie
  // yet. Only re-activates when it actually differs, so this does not
  // re-run the dynamic `.po` import on every render.
  //
  // fix-round 2 (CI-2): `isLocaleConfirmedByUser` guards against undoing a
  // switch the user JUST made on THIS device via `LanguageSection.choose()`.
  // `AuthProvider` remounts on every locale change (CR-M-1's
  // `<Fragment key={locale}>` in `routes/__root.tsx`), so this effect runs
  // fresh right after `choose()` calls `activateLocale()` — at that exact
  // moment `data` is still the PRE-patch cached `['auth','me']` response
  // (the refetch `choose()` triggers via `invalidate()` has not resolved
  // yet), so without the guard this "corrects" `i18n.locale` straight back
  // to the stale value it is about to stop being true. See `lib/i18n.ts`'s
  // doc comment on `isLocaleConfirmedByUser` for the full mechanism —
  // including why fix-round 3 (CR-M-2, PR #706) evaluated and REJECTED
  // replacing this guard with an optimistic cache write.
  useEffect(() => {
    if (!data?.locale) return
    if (data.locale === i18n.locale) {
      // Cache has caught up with whatever `i18n.locale` currently is — a
      // `markLocaleConfirmedByUser` marker (if any) has served its purpose.
      clearConfirmedUserLocaleIfSettled(data.locale)
      return
    }
    // `i18n.locale` is typed as plain `string` by `@lingui/core` — same cast
    // `useLocale()` (`lib/i18n.ts`) already applies to it.
    if (isLocaleConfirmedByUser(i18n.locale as Locale)) return
    void activateLocale(data.locale)
  }, [data?.locale])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })

  return (
    <AuthContext.Provider value={{ user: data ?? null, isLoading, invalidate }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
