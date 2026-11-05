import { routerConfigSchema, type HostedProvider, type RouterConfig } from '../config'
import { createFileManagedModels, createManagedListWriter } from '../managed-models'
import { MODEL_LISTING_URLS } from '../model-listing'
import type { ModelRefreshDeps, ModelRefreshEvent } from '../model-refresh'
import {
  createMemoryRouteStatePort,
  EMPTY_ROUTE_STATE,
  type FreeLimit,
  type OwnCapPort,
  type RouteState,
  type StateEvent,
} from '../state'
import { fakeFs } from './fake-fs'
import {
  answer,
  config,
  countingCap,
  GEMINI,
  GROQ,
  LOCAL,
  scriptedFetch,
  type Reply,
  type Sent,
} from './router-harness'

export const G1 = 'gemini-2.5-flash'
export const G2 = 'gemini-2.5-flash-lite'
export const NEW = 'gemini-3.0-flash'
export const Q1 = 'openai/gpt-oss-120b'
export const Q2 = 'openai/gpt-oss-20b'
export const MANAGED_PATH = '/data/managed-models.json'
export const NOON = Date.parse('2026-11-04T12:00:00Z')
export const noonOf = (day: string): number => Date.parse(`${day}T12:00:00Z`)

/** A Gemini listing from `[id, reportedContext]` pairs; `undefined` reports no limit. */
export const geminiListing = (entries: readonly (readonly [string, number?])[]): Reply => ({
  status: 200,
  body: JSON.stringify({
    models: entries.map(([id, limit]) => ({ name: `models/${id}`, inputTokenLimit: limit })),
  }),
})
export const groqListing = (entries: readonly (readonly [string, number?, boolean?])[]): Reply => ({
  status: 200,
  body: JSON.stringify({
    data: entries.map(([id, context, active]) => ({
      id,
      context_window: context,
      active: active ?? true,
    })),
  }),
})

export const ALIVE = answer({ ok: true })
export const managedDoc = (providers: object): string => JSON.stringify({ version: 1, providers })

/** A cap granting the first `units` reservations, counting like `countingCap`. */
export function limitedCap(units: number): ReturnType<typeof countingCap> {
  const cap = countingCap()
  const reserve = cap.reserve
  let left = units
  cap.reserve = async (p: HostedProvider, limit: FreeLimit) => {
    const unit = await reserve(p, limit)
    return left-- > 0 ? unit : null
  }
  return cap
}

export type WorldOptions = {
  routes?: unknown[]
  listing?: Partial<Record<HostedProvider, Reply>>
  chat?: (s: Sent) => Reply
  managed?: string
  state?: RouteState
  cap?: OwnCapPort
  nowMs?: number
  hadOkCall?: ModelRefreshDeps['hadOkCall']
}

/** Real reader, writer and state port over a fake file system, with a fake `fetchImpl`. */
export function refreshWorld(opts: WorldOptions = {}) {
  const fs = fakeFs(opts.managed === undefined ? {} : { [MANAGED_PATH]: opts.managed })
  const events: ModelRefreshEvent[] = []
  const storeEvents: StateEvent[] = []
  const sleeps: number[] = []
  const listing = {
    gemini: geminiListing([
      [G1, 1_000_000],
      [G2, 1_000_000],
    ]),
    groq: groqListing([
      [Q1, 131_072],
      [Q2, 131_072],
    ]),
    ...opts.listing,
  }
  const listingUrls: string[] = Object.values(MODEL_LISTING_URLS)
  const net = {
    chat: opts.chat ?? ((): Reply => ALIVE),
    listing,
  }
  const fake = scriptedFetch((s) => {
    if (!listingUrls.includes(s.url)) return net.chat(s)
    return s.url === MODEL_LISTING_URLS.gemini ? net.listing.gemini : net.listing.groq
  })
  const state = createMemoryRouteStatePort(opts.state ?? EMPTY_ROUTE_STATE)
  const cap = opts.cap ?? countingCap()
  const clock = { ms: opts.nowMs ?? NOON }
  const deps: ModelRefreshDeps = {
    config: routerConfigSchema.parse(config(opts.routes ?? [GEMINI, GROQ, LOCAL])) as RouterConfig,
    state,
    ownCap: cap,
    managedModels: createFileManagedModels({
      path: MANAGED_PATH,
      fs,
      state,
      onEvent: (e) => storeEvents.push(e),
    }),
    writeManagedList: createManagedListWriter({
      path: MANAGED_PATH,
      fs,
      onEvent: (e) => storeEvents.push(e),
    }),
    onEvent: (e) => events.push(e),
    now: () => clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetchImpl: fake.fetchImpl,
    hadOkCall: opts.hadOkCall,
  }
  return {
    deps,
    fs,
    net,
    clock,
    cap,
    state,
    events,
    storeEvents,
    sleeps,
    sent: fake.sent,
    /** Every chat request, in order; a listing is not one. */
    chats: (): Sent[] => fake.sent.filter((s) => !listingUrls.includes(s.url)),
    chatModels: (): string[] =>
      fake.sent.filter((s) => !listingUrls.includes(s.url)).map((s) => s.model),
    fileText: (): string | undefined => fs.files.get(MANAGED_PATH),
    fileList: (p: HostedProvider): string[] | undefined =>
      (
        JSON.parse(fs.files.get(MANAGED_PATH) ?? '{"providers":{}}') as {
          providers: Partial<Record<HostedProvider, string[]>>
        }
      ).providers[p],
    ofType: <T extends ModelRefreshEvent['type']>(type: T) =>
      events.filter((e): e is Extract<ModelRefreshEvent, { type: T }> => e.type === type),
  }
}
