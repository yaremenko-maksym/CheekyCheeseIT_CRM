/**
 * IndexedDB persister for TanStack Query.
 *
 * Uses idb-keyval as the async storage backend and
 * @tanstack/query-async-storage-persister to create a Persister compatible
 * with PersistQueryClientProvider.
 *
 * KEY CONTRACT: The storage key MUST match the key deleted by use-logout.ts
 * (idbDel('crm-query-cache')). Both must stay in sync — changing the key here
 * without updating use-logout.ts causes a security leak: stale user data
 * survives logout on shared devices.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { get, set, del } from 'idb-keyval'

/** Must match the key deleted in use-logout.ts → idbDel('crm-query-cache'). */
export const PERSIST_KEY = 'crm-query-cache'

/**
 * idb-keyval adapter conforming to the AsyncStorage interface expected by
 * createAsyncStoragePersister. The adapter translates idb-keyval's (key)
 * signatures to the (key, value?) signatures used by the persister.
 */
const idbStorage = {
  getItem: (key: string) => get<string>(key),
  setItem: (key: string, value: string) => set(key, value),
  removeItem: (key: string) => del(key),
}

/**
 * SR-M-1 (PR #646 fix-round 1). `PERSISTED_KEY_PREFIXES` (__root.tsx) is a
 * per-QUERY allow-list — it decides WHICH queries reach IndexedDB, not what
 * WITHIN a query's data gets written. `rejectionReason` (up to 500 chars of
 * why someone declined a project's money terms) rides along on the
 * `'projects'` key, which the allow-list's own comment promises is
 * "non-PII reference data" — untrue for this field, and the PR that added it
 * also mounts `PendingProjectApprovalsPanel` on dashboards, so a DROP's
 * IndexedDB fills with this too, not just ADMIN's.
 *
 * Field-level, not query-level, on purpose: excluding the WHOLE `'projects'`
 * key from persistence would also drop genuinely non-sensitive data (name,
 * companyName, domain, status) that the allow-list's comment is right about
 * — the fix is narrower than the query-level tool available.
 *
 * SR-M-2 (same review, explicitly NOT fixed in this PR — pre-existing, out
 * of this diff): the same `'projects'` key already persists other
 * non-anonymous fields (`members[].email`, `rate`, share percentages,
 * `notesGeneral`). This list is the natural extension point for that
 * follow-up — add the field name here, nothing else changes.
 */
export const SENSITIVE_PERSISTED_FIELDS = new Set<string>(['rejectionReason'])

/**
 * Deep-walks a value about to be written to IndexedDB and drops any object
 * key in `SENSITIVE_PERSISTED_FIELDS`, at any depth (works whether a query's
 * `state.data` is a single project object — findOne-shaped — or an array of
 * them — findAll-shaped — without the strip needing to know which). Untyped
 * on purpose (`unknown`): the input is `PersistedClient`, an
 * `@tanstack/query-persist-client-core` type this package does not declare
 * as a direct dependency (only `@tanstack/query-async-storage-persister`
 * is) — `serialize`'s signature below is typed from that library's own
 * options instead of importing the type directly, so this helper stays
 * structural rather than depending on a transitive package's types.
 *
 * QA-H-3 (PR #646 fix-round 4): `onStrip`, when given, is called once per
 * key actually removed — this is how `markStrippedQueries` below knows,
 * PER QUERY, whether this walk actually redacted anything (as opposed to
 * walking a query that never had a sensitive field to begin with). Optional
 * and side-effect-only so every existing direct call
 * (`stripSensitiveFields(value)`, no second argument) keeps working
 * unchanged.
 */
export function stripSensitiveFields(value: unknown, onStrip?: () => void): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSensitiveFields(v, onStrip))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => {
          if (SENSITIVE_PERSISTED_FIELDS.has(key)) {
            onStrip?.()
            return false
          }
          return true
        })
        .map(([key, v]) => [key, stripSensitiveFields(v, onStrip)]),
    )
  }
  return value
}

/**
 * QA-H-3 (PR #646 fix-round 4, HIGH — manual-qa repro on `/projects?status=
 * REJECTED`). `stripSensitiveFields` above keeps `rejectionReason` out of
 * IndexedDB — but a query WRITTEN with the field already gone is, from
 * TanStack Query's point of view, an ordinary successful snapshot with a
 * normal `dataUpdatedAt`. `staleTime` (60s, query-client.ts) has no way to
 * know this particular snapshot is short a field: within that window,
 * `useQuery` treats "restored from disk" identically to "freshly fetched"
 * and never re-asks the server — an ADMIN who reloads `/projects` within
 * 60s of their last visit silently loses the rejection reason until
 * `staleTime` elapses on its own, with no loading state, no error, nothing
 * to notice.
 *
 * Fix, in two halves:
 *   1. HERE (write time) — `markStrippedQueries` marks every query
 *      `stripQuery` actually redacted something from, via `meta.strippedAt`.
 *      `DehydratedQuery.meta` (`@tanstack/query-core`'s own dehydrate/
 *      hydrate contract) is a plain, arbitrary, JSON-serializable bag that
 *      survives a restore untouched — exactly the kind of place a "this
 *      snapshot is short a field" flag belongs, as opposed to inventing a
 *      side-channel this file would also have to restore by hand.
 *   2. `forceRefetchOfStrippedQueries` below (read time) — turns that mark
 *      into `state.dataUpdatedAt = 0` on the SAME query, right before
 *      `hydrate()` builds it. A query with `dataUpdatedAt = 0` is
 *      unconditionally stale (`query-core`'s `isStaleByTime`: compares
 *      `Date.now() - dataUpdatedAt` against `staleTime`, and `0` always
 *      loses against a finite `staleTime`) — which is exactly what
 *      `refetchOnMount`'s default (`true`, unset in query-client.ts) checks
 *      on the very next `useQuery` mount for that key: it fetches in the
 *      background, same as if the cache had been empty, and the real
 *      `rejectionReason` comes back from the server. A query nothing was
 *      stripped from (SENIOR/DROP never receive `rejectionReason` at all —
 *      SR-M-5, fix-round 2) gets no mark and behaves exactly as before this
 *      fix — no unnecessary refetch is introduced for the common case.
 *
 * Deliberately per-QUERY (via `state` AND `meta`, not `state.data` alone):
 * the original `stripSensitiveFields(client)` call this replaces walked the
 * ENTIRE client, including `query.state.error`/`fetchFailureReason` —
 * walking `query.state` here (not just `.data`) keeps that same coverage
 * while still being able to tell whether THIS query's data needed
 * stripping at all. `clientState.mutations` (a paused/offline mutation
 * carrying the same shape) goes through the original, tracking-free strip
 * — no staleness marker is meaningful there since mutations are not
 * restored through the `useQuery`/`staleTime` path this fix targets.
 *
 * SR-M-8 (PR #646 fix-round 5, MED). `query.meta` is walked through the
 * SAME strip as `state`, for the same "keep that same coverage" reason —
 * this file's own doc used to claim `query.state` alone matched the old
 * whole-client walk's coverage, which was never true for `meta`: the old
 * walk was fully generic and would have recursed into it like any other
 * nested object, but `stripQuery` only ever WROTE `meta` (the `strippedAt`
 * mark below), never READ it for stripping. Not exploitable today (no
 * `useQuery({ meta })` call in apps/web puts anything sensitive there, and
 * `dehydrate()` never invents a `meta` value on its own) — this closes the
 * gap for the day one does, and for `SENSITIVE_PERSISTED_FIELDS`'s own
 * documented SR-M-2 extension point.
 */
function stripQuery(query: unknown): unknown {
  if (query === null || typeof query !== 'object') return query
  const q = query as { state?: unknown; meta?: unknown }
  let strippedSomething = false
  const onStrip = () => {
    strippedSomething = true
  }
  const state = stripSensitiveFields(q.state, onStrip)
  const meta = stripSensitiveFields(q.meta, onStrip) as Record<string, unknown> | undefined
  if (!strippedSomething) return { ...q, state }
  return { ...q, state, meta: { ...(meta ?? {}), strippedAt: Date.now() } }
}

/**
 * See `stripQuery`'s doc above — walks `clientState.{queries,mutations}`.
 *
 * Exported (mutation-gate closure, PR #646 fix-round 4) purely for
 * testability, alongside `stripSensitiveFields` above: `serialize`'s only
 * PUBLIC output is a JSON string, and `JSON.stringify` unconditionally drops
 * an `undefined`-valued object property — so a mutant that turns "the
 * `mutations` key is conditionally spread in" into "always spread in (as
 * `{ mutations: undefined }` when `cs.mutations` was never defined)" is
 * byte-identical after `JSON.stringify` and invisible to any test that only
 * ever sees `serialize`'s string output. Exporting this function lets
 * `persister.spec.ts` assert on the PRE-stringify object directly (`'mutations'
 * in result`, which — unlike `JSON.stringify` — DOES distinguish "key absent"
 * from "key present with value `undefined`"), closing the gap with a real
 * assertion instead of a suppression that would have had to excuse three
 * mutants at once (two equivalent, but ALSO the one genuinely-killed `false`
 * variant sitting on the same line — Stryker's suppression directive cannot
 * be more specific than "this mutator, this line").
 *
 * SR-M-8 (PR #646 fix-round 5, MED). `queries` is destructured OUT of `cs`
 * before the spread below, not left inside it. The previous shape —
 * `...cs, ...(Array.isArray(cs.queries) && { queries: ... })` — failed
 * CLOSED only by accident: when `cs.queries` is not an array, the
 * conditional spread contributes nothing, but `...cs` a few characters
 * earlier had ALREADY put the original, unstripped `queries` value into
 * the result. A malformed `clientState.queries` (never produced by a real
 * `dehydrate()`, per this file's own "defensive guards" doc below, but not
 * provably impossible either — a crashed tab's partial write, a schema
 * left over from an older app version) used to be written to disk
 * completely unstripped. Destructuring it out of `rest` means the ONLY way
 * `queries` reaches the output at all is the explicit, stripped re-add
 * below — the malformed case is OMITTED, not passed through raw.
 */
export function markStrippedQueries(clientState: unknown): unknown {
  if (clientState === null || typeof clientState !== 'object') return clientState
  const cs = clientState as { queries?: unknown; mutations?: unknown; [k: string]: unknown }
  const { queries, ...rest } = cs
  return {
    ...rest,
    ...(cs.mutations !== undefined && { mutations: stripSensitiveFields(cs.mutations) }),
    ...(Array.isArray(queries) && { queries: queries.map(stripQuery) }),
  }
}

/** Extracted from createAsyncStoragePersister's own options — see stripSensitiveFields' doc for why not a direct PersistedClient import. */
type Serialize = NonNullable<Parameters<typeof createAsyncStoragePersister>[0]['serialize']>
/** Same pattern, for the RETURN side of the library's own `restoreClient` — a `PersistedClient | undefined` this file still never names directly. */
type StoragePersister = ReturnType<typeof createAsyncStoragePersister>
type RestoredClient = Awaited<ReturnType<StoragePersister['restoreClient']>>

const serialize: Serialize = (client) => {
  if (client === null || typeof client !== 'object') {
    return JSON.stringify(stripSensitiveFields(client))
  }
  const c = client as unknown as { clientState?: unknown; [k: string]: unknown }
  return JSON.stringify({ ...c, clientState: markStrippedQueries(c.clientState) })
}

/**
 * QA-H-3, read-time half — see `stripQuery`'s doc above for the full
 * mechanism. Runs on whatever `baseAsyncPersister.restoreClient()` (below)
 * returned, BEFORE `PersistQueryClientProvider` hands it to `hydrate()`.
 * A query with no `meta.strippedAt` mark is returned byte-for-byte —
 * `undefined` (nothing was ever persisted) passes straight through too.
 */
function forceRefetchOfStrippedQueries(client: RestoredClient): RestoredClient {
  if (client === null || typeof client !== 'object') return client
  const c = client as unknown as { clientState?: { queries?: unknown[]; [k: string]: unknown } }
  const queries = c.clientState?.queries
  if (!Array.isArray(queries)) return client
  return {
    ...c,
    clientState: {
      ...c.clientState,
      queries: queries.map((query) => {
        if (query === null || typeof query !== 'object') return query
        const q = query as { meta?: { strippedAt?: unknown }; state?: Record<string, unknown> }
        if (q.meta?.strippedAt === undefined) return q
        return { ...q, state: { ...q.state, dataUpdatedAt: 0 } }
      }),
    },
  } as RestoredClient
}

const baseAsyncPersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: PERSIST_KEY,
  // Throttle writes: avoid IndexedDB spam on burst invalidations.
  throttleTime: 1000,
  serialize,
})

/**
 * QA-H-3: same `persistClient`/`removeClient` as the underlying library
 * instance (unwrapped — no query-level logic runs on write beyond
 * `serialize` above, already wired into `baseAsyncPersister`) — only
 * `restoreClient` is wrapped, to run `forceRefetchOfStrippedQueries` on
 * whatever the real library restored before `PersistQueryClientProvider`
 * hydrates the QueryClient with it.
 */
export const persister: StoragePersister = {
  persistClient: baseAsyncPersister.persistClient,
  removeClient: baseAsyncPersister.removeClient,
  restoreClient: async () =>
    forceRefetchOfStrippedQueries(await baseAsyncPersister.restoreClient()),
}
