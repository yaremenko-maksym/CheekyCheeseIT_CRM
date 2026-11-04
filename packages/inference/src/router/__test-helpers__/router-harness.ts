import { z } from 'zod'
import type { FetchLike } from '../../http/bounded-request'
import type { RouterConfigInput } from '../config'
import type { RouterDeps, RouterEvent } from '../router'
import { createMemoryRouteStatePort, type OwnCapPort, type RouteStatePort } from '../state'

/** Seeded markers: none may ever appear in an event, a result or an error (AC5). */
export const KEY_MARKER = 'sk-KEY-MARKER-91c2'
export const TEXT_MARKER = 'TEXT-MARKER-5d1e'
export const PROVIDER_BODY_MARKER = 'BODY-MARKER-7f3a'

export const SCHEMA = z.object({ title: z.string(), salary: z.number().optional() })
export const REQ = { input: `synthetic page ${TEXT_MARKER}`, schema: SCHEMA }

export const LOCAL = {
  provider: 'local' as const,
  baseUrl: 'http://crm-model-runtime:11434/v1',
  model: 'qwen2.5:3b',
  contextTokens: 32_000,
  structuredOutput: 'json_schema' as const,
  timeoutMs: 5_000,
  maxAnswerTokens: 500,
}
export const GROQ = {
  provider: 'groq' as const,
  apiKey: KEY_MARKER,
  models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  contextTokens: 32_000,
  structuredOutput: 'json_schema' as const,
  minGapMs: 0,
  timeoutMs: 5_000,
  maxAnswerTokens: 800,
  freeLimit: { requestsPerDay: 1000 },
}
export const GEMINI = {
  ...GROQ,
  provider: 'gemini' as const,
  models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
}

export function config(routes: unknown[], extra: object = {}): RouterConfigInput {
  return {
    policyVersion: 'test-1',
    hostedBudgetMs: 60_000,
    floorBudgetMs: 60_000,
    routes,
    ...extra,
  } as RouterConfigInput
}

export type Reply =
  | { status: number; body: string; headers?: Record<string, string>; delayMs?: number }
  /** Never answers; rejects as an abort when the request's signal fires. */
  | 'hang'
  /** The connection is never made. */
  | 'network'

export type Sent = {
  host: string
  url: string
  model: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export const answer = (
  content: unknown,
  extra: Record<string, unknown> = {},
  finish = 'stop',
): Reply => ({
  status: 200,
  body: JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }],
    usage: { total_tokens: 10 },
    ...extra,
  }),
})
export const GOOD = answer({ title: 'Engineer' })

/**
 * A fake `fetchImpl` answering by host and model from `script`; it records every request and the
 * peak number in flight. A function reply is computed per request.
 */
export function scriptedFetch(script: (s: Sent, n: number) => Reply) {
  const sent: Sent[] = []
  let inFlight = 0
  const stats = { peakInFlight: 0, peakLocalInFlight: 0 }
  let localInFlight = 0
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    const s: Sent = {
      host: new URL(url).hostname,
      url,
      model: String(body.model),
      headers: init?.headers ?? {},
      body,
    }
    sent.push(s)
    const reply = script(s, sent.length)
    const local = s.host === 'crm-model-runtime'
    inFlight++
    if (local) localInFlight++
    stats.peakInFlight = Math.max(stats.peakInFlight, inFlight)
    stats.peakLocalInFlight = Math.max(stats.peakLocalInFlight, localInFlight)
    try {
      if (reply === 'network') throw new TypeError('fetch failed')
      if (reply === 'hang') {
        await new Promise((_resolve, reject) => {
          const signal = init?.signal
          const stop = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted === true) stop()
          signal?.addEventListener('abort', stop)
        })
      }
      const r = reply as Exclude<Reply, 'hang' | 'network'>
      if (r.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, r.delayMs))
      return {
        status: r.status,
        body: null,
        text: async () => r.body,
        headers: { get: (n: string) => r.headers?.[n] ?? null },
      }
    } finally {
      inFlight--
      if (local) localInFlight--
    }
  }
  return { fetchImpl, sent, stats }
}

/** An `OwnCapPort` that grants everything and counts reservations and releases per provider. */
export function countingCap(grant = true): OwnCapPort & { reserved: string[]; released: string[]; tokens: number } {
  const cap = {
    reserved: [] as string[],
    released: [] as string[],
    tokens: 0,
    async reserve(p: string) {
      cap.reserved.push(p)
      return grant
    },
    async release(p: string) {
      cap.released.push(p)
    },
    async addTokens(_p: string, n: number) {
      cap.tokens += n
    },
  }
  return cap
}

export function deps(
  fetchImpl: FetchLike,
  extra: Partial<RouterDeps> = {},
): RouterDeps & { events: RouterEvent[]; routeState: RouteStatePort; sleeps: number[] } {
  const events: RouterEvent[] = []
  const sleeps: number[] = []
  return {
    onEvent: (e) => events.push(e),
    routeState: createMemoryRouteStatePort(),
    ownCap: countingCap(),
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    events,
    sleeps,
    ...extra,
  } as RouterDeps & { events: RouterEvent[]; routeState: RouteStatePort; sleeps: number[] }
}

export const hostOf = { groq: 'api.groq.com', gemini: 'generativelanguage.googleapis.com', local: 'crm-model-runtime' }
