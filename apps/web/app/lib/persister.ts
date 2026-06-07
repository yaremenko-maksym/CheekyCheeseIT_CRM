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

export const persister = createAsyncStoragePersister({
  storage: idbStorage,
  key: PERSIST_KEY,
  // Throttle writes: avoid IndexedDB spam on burst invalidations.
  throttleTime: 1000,
})
