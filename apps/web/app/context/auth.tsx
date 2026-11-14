import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { notifyManager, useQuery, useQueryClient, useIsRestoring } from '@tanstack/react-query'
import type { Query, QueryClient } from '@tanstack/react-query'
import { del as idbDel } from 'idb-keyval'
import type { Locale, SessionUser } from '@crm/shared'
import { api } from '../lib/axios'
import { PERSIST_KEY, setPersistedCacheOwner, takeRestoredCacheOwner } from '../lib/persister'
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

// `timeout` 0 is axios's "no timeout"; only the route-change revalidation sets one
async function fetchMe(timeout = 0): Promise<SessionUser | null> {
  const res = await api.get<SessionUser>('/auth/me', {
    timeout,
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
const REVALIDATE_TIMEOUT_MS = 3000 // a hung check counts as a network failure, not a blocked navigation

/**
 * PR #1330 CR-H-1: every scoped query key derives from the `auth/me` user, so ANY answer that
 * changes its id (the revalidator below, a refetch on reconnect or remount, `invalidateQueries`,
 * an outside `setQueryData`) purges every other query and the persisted copy, synchronously,
 * before observers re-render. The first answer after a page load is compared with the restored
 * cache's owner instead (SR-M-1, `lib/persister.ts`).
 *
 * Backlog 433: the purge is immediate, the refetch is not while `navigating()` is true. Queries of
 * the page being left are still mounted then, and refetching them as an account with fewer rights
 * answers 403. Their refetch waits for the returned `settle`, which the layout calls once the
 * navigation is done: only the observers still mounted then (header, bell, the new page) refetch.
 */
function watchSessionOwner(queryClient: QueryClient, navigating: () => boolean): () => void {
  const cached = queryClient.getQueryData<SessionUser | null>(AUTH_ME_KEY)
  let owner = cached === undefined ? undefined : (cached?.id ?? null)
  let purged: Set<Query> | null = null
  const refetchPurged = () => {
    const queries = purged
    purged = null
    if (!queries) return
    // cancelRefetch false: a query the new page mounted is already fetching, do not ask twice
    void queryClient
      .refetchQueries(
        { type: 'active', predicate: (q) => queries.has(q) },
        { cancelRefetch: false },
      )
      .catch(() => {})
  }
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || !isAuthMe(event.query))
      return
    const id = (event.query.state.data as SessionUser | null)?.id ?? null
    const previous = owner === undefined ? takeRestoredCacheOwner() : owner
    owner = id
    setPersistedCacheOwner(id)
    if (previous === undefined || previous === id) return
    // reset, not remove: mounted observers (header, bell) drop the old data and stay subscribed
    const matched = queryClient.getQueryCache().findAll({ predicate: (q) => !isAuthMe(q) })
    notifyManager.batch(() => matched.forEach((q) => q.reset()))
    purged = new Set([...(purged ?? []), ...matched])
    void idbDel(PERSIST_KEY).catch(() => {})
    if (!navigating()) refetchPurged()
  })
  return refetchPurged
}

/**
 * Task 7.6c: the session cookie can change under an open page (a sign-in in another tab), and the
 * cached `auth/me` user would never notice. The `_authenticated` route awaits this in `beforeLoad`:
 * it fetches a fresh answer and writes it to `auth/me`, so `watchSessionOwner` purges a changed
 * user BEFORE the next route renders. The same pathname within `REUSE_MS` of the last check (the
 * click after a hover preload — the router reports an active layout's preload as `preload: false`)
 * reuses that check; a later visit to the same pathname asks again. A check overtaken by a newer
 * one waits for that one, so no navigation renders before the newest answer is applied; if the
 * newer one fails, the overtaken answer still lands. A check that fails or takes over
 * `REVALIDATE_TIMEOUT_MS` keeps the cache. Nothing before the first `auth/me` answer
 * (AuthProvider owns that). Create one per client: it subscribes to its cache.
 *
 * A switch found by a check defers the refetch of the purged queries until `settled()`: the layout
 * calls it once the router is idle again (backlog 433, see `watchSessionOwner`).
 */
export function createSessionRevalidator(queryClient: QueryClient) {
  const REUSE_MS = 1000 // hover preload, then click
  let pending = 0 // checks in flight: a purge during one belongs to a navigation not yet rendered
  const settled = watchSessionOwner(queryClient, () => pending > 0)
  let last: { pathname: string; check: Promise<void>; settledAt: number | null } | null = null
  let asked = 0 // sequence of the newest check
  let applied = 0 // sequence of the newest check whose answer landed
  const check = async (): Promise<void> => {
    if (!queryClient.getQueryData<SessionUser | null>(AUTH_ME_KEY)) return
    // A request of its own, not a deduped `fetchQuery`: the router pushes the URL before
    // `beforeLoad` settles, so an earlier request may still be in flight under the OLD cookie.
    const mine = ++asked
    let current: SessionUser | null
    try {
      current = await fetchMe(REVALIDATE_TIMEOUT_MS)
    } catch {
      return // network failure or timeout: keep the cache (offline use); the server still enforces access
    }
    // a later check asked after us: its answer wins, and this navigation waits for it; ours lands
    // only if no later answer did (the later check failed). `last` is never null here: it is
    // assigned synchronously, before `fetchMe` can answer
    if (mine !== asked) {
      await last!.check
      if (applied > mine) return
    }
    applied = mine
    // AuthProvider's own request may also predate the cookie change; its late answer must not land
    await queryClient.cancelQueries({ queryKey: AUTH_ME_KEY, exact: true })
    queryClient.setQueryData(AUTH_ME_KEY, current) // a changed id purges in `watchSessionOwner`
  }
  const revalidate = (pathname: string): Promise<void> => {
    const fresh = last?.settledAt == null || Date.now() - last.settledAt < REUSE_MS
    if (last && last.pathname === pathname && fresh) return last.check
    const entry: NonNullable<typeof last> = { pathname, check: Promise.resolve(), settledAt: null }
    pending++
    entry.check = check().finally(() => {
      pending--
      entry.settledAt = Date.now()
    })
    last = entry
    return entry.check
  }
  return Object.assign(revalidate, { settled })
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
    queryFn: () => fetchMe(),
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
