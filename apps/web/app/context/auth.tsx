import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { notifyManager, useQuery, useQueryClient, useIsRestoring } from '@tanstack/react-query'
import type { Query, QueryClient } from '@tanstack/react-query'
import { del as idbDel } from 'idb-keyval'
import type { Locale, SessionUser } from '@crm/shared'
import { api } from '../lib/axios'
import {
  PERSIST_KEY,
  purgePersistedBeforeReload,
  setPersistedCacheOwner,
  takeRestoredCacheOwner,
} from '../lib/persister'
import {
  activateLocale,
  clearConfirmedUserLocaleIfSettled,
  i18n,
  isLocaleConfirmedByUser,
} from '../lib/i18n'
import { reportClientError, sanitizeErrorForReport } from '../lib/telemetry/errors'

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
    // PR #140: clear on session-expiry, not only on explicit logout). Best-effort. Logout's path:
    // stop persisting first, so no save lands after the delete (one-way: this page is signed out).
    void purgePersistedBeforeReload()
    return null
  }
  // API already validates shape via JWT — trust the response and cast directly
  return res.data
}

/**
 * The session's `locale` differs from the active one and the user did not just pick the active one
 * on this device (`isLocaleConfirmedByUser`, see `AuthProvider`'s locale effect). `i18n.locale` is
 * typed as plain `string` by `@lingui/core`, the same cast `useLocale()` applies.
 */
function needsActivation(sessionLocale: Locale): boolean {
  return sessionLocale !== i18n.locale && !isLocaleConfirmedByUser(i18n.locale as Locale)
}

// A catalog import that never settles must not hold the pending UI forever; a chunk load slower
// than this is treated as failed (PR #1343 SR-L-1)
const LOCALE_ACTIVATION_TIMEOUT_MS = 10_000

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
 * `onSwitch` hears every change of id, before the purge.
 */
function watchSessionOwner(
  queryClient: QueryClient,
  navigating: () => boolean,
  onSwitch: () => void,
): () => void {
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
    if (previous === undefined || previous === id) {
      setPersistedCacheOwner(id)
      return
    }
    onSwitch()
    // reset, not remove: mounted observers (header, bell) drop the old data and stay subscribed
    const matched = queryClient.getQueryCache().findAll({ predicate: (q) => !isAuthMe(q) })
    notifyManager.batch(() => matched.forEach((q) => q.reset()))
    // Only now: each reset runs the persister at once, and a save serialized mid-reset still holds
    // the old rows, so it must name their owner; the next load as the new user refuses it (SR-H-1)
    setPersistedCacheOwner(id)
    const queries = (purged ??= new Set<Query>())
    matched.forEach((q) => queries.add(q))
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
 * reuses that check; a later visit to the same pathname asks again. A check overtaken by newer
 * ones waits for all of them, so no navigation renders before the newest answer is applied and an
 * older answer never lands after a newer one; if every newer one fails, the overtaken answer still
 * lands, unless `auth/me` changed user after it was sent (AuthProvider's own answer, PR #1334
 * SR-L-1). A check that fails or takes over
 * `REVALIDATE_TIMEOUT_MS` keeps the cache. Nothing before the first `auth/me` answer
 * (AuthProvider owns that). Create one per client: it subscribes to its cache.
 *
 * A switch found by a check defers the refetch of the purged queries until `settled()`: the layout
 * calls it once the router is idle again (backlog 433, see `watchSessionOwner`). A switch that lands
 * after that, with no navigation asked since (an overtaken check), refetches at once (SR-L-2).
 */
export function createSessionRevalidator(queryClient: QueryClient) {
  const REUSE_MS = 1000 // hover preload, then click
  const inflight = new Map<number, Promise<void>>() // checks in flight, by sequence
  let last: { pathname: string; check: Promise<void>; settledAt: number | null } | null = null
  let asked = 0 // sequence of the newest check
  let rendered = 0 // `asked` when the router last went idle: those navigations are on screen
  let floor = 1 // a check below this sequence is stale: `auth/me` took a newer answer
  // A purge while a check runs belongs to a navigation not yet rendered, unless no navigation was
  // asked since the router went idle. Any switch outdates every check sent before it (SR-L-1); a
  // check's own landing lowers that again to its own sequence, below.
  const refetchPurged = watchSessionOwner(
    queryClient,
    () => inflight.size > 0 && asked > rendered,
    () => {
      floor = asked + 1
    },
  )
  const settled = () => {
    rendered = asked
    refetchPurged()
  }
  const newerThan = (mine: number) =>
    [...inflight].filter(([seq]) => seq > mine).map(([, running]) => running)
  const answer = async (mine: number): Promise<void> => {
    // A request of its own, not a deduped `fetchQuery`: the router pushes the URL before
    // `beforeLoad` settles, so an earlier request may still be in flight under the OLD cookie.
    let current: SessionUser | null
    try {
      current = await fetchMe(REVALIDATE_TIMEOUT_MS)
    } catch {
      return // network failure or timeout: keep the cache (offline use); the server still enforces access
    }
    // Checks asked after us (even while we wait) are waited for, so this navigation renders only
    // after the newest answer.
    for (let newer = newerThan(mine); newer.length > 0; newer = newerThan(mine)) {
      await Promise.all(newer)
    }
    // A newer answer is already in: a newer check's (it landed while we waited, or before ours
    // even arrived), or any switch of user since ours was sent. Ours lands only if every newer
    // check failed and nothing else changed the user. Checked before the cancel: a check that
    // drops its answer leaves AuthProvider's request, possibly fresher than ours, alone (SO-1).
    if (mine < floor) return
    // AuthProvider's own request may also predate the cookie change; its late answer must not land
    await queryClient.cancelQueries({ queryKey: AUTH_ME_KEY, exact: true })
    if (mine < floor) return // the cancel yields: a newer answer may have landed meanwhile
    queryClient.setQueryData(AUTH_ME_KEY, current) // a changed id purges in `watchSessionOwner`
    // after the write: our own switch must not outdate a check asked after ours was sent
    floor = mine + 1
  }
  const check = async (): Promise<void> => {
    if (!queryClient.getQueryData<SessionUser | null>(AUTH_ME_KEY)) return
    const mine = ++asked
    const running = answer(mine).finally(() => inflight.delete(mine))
    inflight.set(mine, running)
    await running
  }
  const revalidate = (pathname: string): Promise<void> => {
    const fresh = last?.settledAt == null || Date.now() - last.settledAt < REUSE_MS
    if (last && last.pathname === pathname && fresh) return last.check
    const entry: NonNullable<typeof last> = { pathname, check: Promise.resolve(), settledAt: null }
    entry.check = check().finally(() => {
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

  // A session locale whose catalog failed (or timed out) to load: released from the wait below, the
  // app stays in the active locale rather than on a pending screen forever. Scoped to the user it
  // failed for: this provider outlives a session switch (PR #1343 SO-1).
  const [failedLocale, setFailedLocale] = useState<{ userId: string; locale: Locale } | null>(null)
  const hasFailed = (userId: string, locale: Locale) =>
    failedLocale?.userId === userId && failedLocale.locale === locale
  // The session's `locale` still has to be activated. Activating it remounts everything below
  // `LocaleScopedApp`'s `<Fragment key={locale}>` (`routes/__root.tsx`), so until then consumers
  // see `isLoading` and render their pending UI: nothing the user could interact with is torn
  // down by that remount at first login. `i18n.locale` read in render is current because that
  // same key remounts this provider on every activation. A background refetch carrying a locale
  // changed elsewhere waits the same way mid-session: the remount would tear the page down anyway.
  const sessionLocaleToApply =
    !!data?.locale && !hasFailed(data.id, data.locale) && needsActivation(data.locale)
  // isLoading = true while IndexedDB is being restored, while the auth query is in flight, OR
  // while the session locale is still to be activated. This prevents the guard from seeing
  // user=null prematurely during the restore window.
  const isLoading = isRestoring || (isPending && isFetching) || sessionLocaleToApply

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
    if (!needsActivation(data.locale)) return
    const { locale, id: userId } = data
    // no retry of a failed locale for the same user (A1): a late success would remount the tree (CR-L)
    if (hasFailed(userId, locale)) return
    // One release per attempt: a late rejection after the timeout is not reported twice
    let settled = false
    const release = (reason: unknown) => {
      if (settled) return
      settled = true
      const { message, stack } = sanitizeErrorForReport(reason)
      reportClientError(`Session locale ${locale} failed to activate: ${message}`, { stack })
      setFailedLocale({ userId, locale })
    }
    const timer = setTimeout(
      () => release(new Error(`timed out after ${LOCALE_ACTIVATION_TIMEOUT_MS} ms`)),
      LOCALE_ACTIVATION_TIMEOUT_MS,
    )
    activateLocale(locale)
      .catch(release)
      .finally(() => clearTimeout(timer))
    // a success remounts this provider: an attempt that is gone (unmount, or superseded by
    // another user / locale) is retired, so neither its timeout nor a late rejection reports or
    // overwrites the failure of the attempt that replaced it (CR-M-3)
    return () => {
      settled = true
      clearTimeout(timer)
    }
    // keyed by user too: another user with the same locale re-attempts (SO-1)
  }, [data?.locale, data?.id])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })

  return (
    <AuthContext.Provider value={{ user: data ?? null, isLoading, invalidate }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
