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
 */
export function stripSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_PERSISTED_FIELDS.has(key))
        .map(([key, v]) => [key, stripSensitiveFields(v)]),
    )
  }
  return value
}

/** Extracted from createAsyncStoragePersister's own options — see stripSensitiveFields' doc for why not a direct PersistedClient import. */
type Serialize = NonNullable<Parameters<typeof createAsyncStoragePersister>[0]['serialize']>

const serialize: Serialize = (client) => JSON.stringify(stripSensitiveFields(client))

export const persister = createAsyncStoragePersister({
  storage: idbStorage,
  key: PERSIST_KEY,
  // Throttle writes: avoid IndexedDB spam on burst invalidations.
  throttleTime: 1000,
  serialize,
})
