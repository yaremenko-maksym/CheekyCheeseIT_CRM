import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { get, set, del } from 'idb-keyval'

// IDB-based storage adapter для TanStack Query persister.
// idb-keyval — минимальный IndexedDB-wrapper без лишних зависимостей.
const idbStorage = {
  getItem: (key: string) => get<string>(key).then((v) => v ?? null),
  setItem: (key: string, value: string) => set(key, value),
  removeItem: (key: string) => del(key),
}

export const queryPersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: 'crm-query-cache',
  // Throttle записи: не чаще раза в секунду при бурстах invalidate
  throttleTime: 1000,
})
