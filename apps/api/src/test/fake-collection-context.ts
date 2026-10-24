import type {
  CachedResponse,
  CollectionContext,
  FetchRequest,
  ValidatedCheckpoint,
} from '../job-sourcing/providers/reporting-provider'

/**
 * A `CollectionContext` made of in-memory fakes, for the XML bindings' specs.
 *
 * Deliberately smaller than the harness in `api-json.provider.spec.ts`: that one exists to pin the
 * LOOP (call order, reservation resolution, persist gating), and the XML specs exercise the loop
 * only through their own bindings. What a binding adds is a body format and a request shape, so
 * this fake records what was sent and what was cached, and serves scripted responses.
 */

export interface FakeResponse {
  status?: number
  bodyText?: string
  etag?: string | null
  headers?: Record<string, string>
  /** The fetch REJECTS with this instead of answering (a network failure). */
  throws?: unknown
}

export interface FakeContext {
  ctx: CollectionContext
  sent: FetchRequest[]
  cache: Map<string, CachedResponse>
  saved: ValidatedCheckpoint[]
}

export function fakeCollectionContext(opts: {
  responses: FakeResponse[]
  now?: Date
  cacheSeed?: Record<string, CachedResponse>
  /** The checkpoint a previous attempt left behind (default: none). */
  stored?: ValidatedCheckpoint | null
}): FakeContext {
  const sent: FetchRequest[] = []
  const saved: ValidatedCheckpoint[] = []
  const cache = new Map<string, CachedResponse>(Object.entries(opts.cacheSeed ?? {}))
  let fetches = 0
  const now = opts.now ?? new Date('2026-10-20T10:00:00Z')

  const ctx: CollectionContext = {
    run: { sourceId: 's', cycleId: 'c', attemptId: 'a', fencingEpoch: 1 },
    policyVersion: 1,
    signal: new AbortController().signal,
    deadline: new Date('2030-01-01T00:00:00Z'),
    now: () => now,
    secrets: [],
    async fetchText(request) {
      sent.push(request)
      const response = opts.responses[fetches]
      fetches += 1
      if (response === undefined) throw new Error(`no fake response for fetch ${fetches}`)
      if (response.throws !== undefined) throw response.throws
      return {
        status: response.status ?? 200,
        bodyText: response.bodyText ?? '',
        headers: response.headers ?? {},
        etag: response.etag ?? null,
      }
    },
    meter: {
      async reserve(unit, amount) {
        return { id: 'r', unit, amount }
      },
      async reconcile() {},
    },
    checkpoints: {
      async load() {
        return opts.stored ?? null
      },
      async savePage({ checkpoint }) {
        saved.push(checkpoint)
      },
    },
    cache: {
      async get(key) {
        return cache.get(key) ?? null
      },
      async put(key, value) {
        cache.set(key, value)
      },
    },
  }
  return { ctx, sent, cache, saved }
}
