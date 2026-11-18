import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileRouteStatePort,
  createOwnCapPort,
  createRouterExtractionAdapter,
  routerReadiness,
  type FetchLike,
} from '@crm/inference'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTACT_PAGES } from '../job-sourcing/structuring/__fixtures__/contact-pages'
import { EXTRACTION_TABLE_VERSION } from './link-contract'
import { buildExtractionWorker } from './server'

/**
 * The privacy obligation of Amendment 2026-11-08 H.9: for every hosted provider, a page carrying
 * every contact shape `stripContacts` handles reaches the provider with none of them. The worker's
 * own strip runs before the router picks a route, so no route, provider or config value skips it.
 */
const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const KEY = 'sk-PRIVACY-KEY-MARKER'
const COMMON = {
  apiKey: KEY,
  contextTokens: 32_000,
  minGapMs: 0,
  timeoutMs: 5_000,
  maxAnswerTokens: 800,
  freeLimit: { requestsPerDay: 1000 },
}
const ROUTES = {
  gemini: { provider: 'gemini', models: ['gemini-2.5-flash'], structuredOutput: 'json_schema' },
  groq: { provider: 'groq', models: ['openai/gpt-oss-20b'], structuredOutput: 'json_schema' },
  cloudflare: {
    provider: 'cloudflare',
    models: ['@cf/mistralai/mistral-small-3.1-24b-instruct'],
    structuredOutput: 'none',
    accountId: '0123456789abcdef0123456789abcdef',
    // Cloudflare's own ceilings: a smaller context and a neuron-sized day.
    contextTokens: 16_000,
    freeLimit: { requestsPerDay: 16 },
  },
  openrouter: {
    provider: 'openrouter',
    models: ['meta-llama/llama-3.3-70b-instruct:free'],
    structuredOutput: 'json_schema',
    dataCollection: 'allow',
  },
} as const
const HOSTS = {
  gemini: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  cloudflare: 'api.cloudflare.com',
  openrouter: 'openrouter.ai',
} as const
const PROVIDERS = Object.keys(ROUTES) as (keyof typeof ROUTES)[]

/** Every string inside a request body: the page can only travel in one of them. */
function stringsOf(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(stringsOf)
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(stringsOf)
  return []
}
const visible = (t: string) =>
  t
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase()
const digitsOf = (t: string) =>
  t
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/\D/g, '')

/** A provider that refuses every request: the router then tries nothing else of that route. */
function recordingFetch() {
  const bodies: unknown[] = []
  const hosts: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    hosts.push(new URL(url).hostname)
    bodies.push(JSON.parse(init?.body ?? '{}'))
    return new Response('', { status: 500 })
  }
  return { fetchImpl, bodies, hosts }
}

const apps: { close: () => Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()))
})

async function worker(provider: keyof typeof ROUTES) {
  const config = {
    policyVersion: 'privacy-1',
    hostedBudgetMs: 10_000,
    routes: [{ ...COMMON, ...ROUTES[provider] }],
  }
  const path = join(mkdtempSync(join(tmpdir(), 'xw-privacy-')), 'route-state.json')
  const routeState = await createFileRouteStatePort({
    path,
    now: Date.now,
    onEvent: () => undefined,
  })
  const net = recordingFetch()
  const app = buildExtractionWorker({
    secret: SECRET,
    routeState,
    log: () => undefined,
    buildPorts: (onEvent) => ({
      extract: createRouterExtractionAdapter(config, {
        onEvent,
        routeState,
        ownCap: createOwnCapPort({ state: routeState, now: Date.now }),
        fetchImpl: net.fetchImpl,
        sleep: async () => undefined,
      }),
      readiness: () => routerReadiness(config, { routeState }),
    }),
  })
  apps.push(app)
  return { app, net }
}

describe.each(PROVIDERS)('extraction worker privacy, the %s route (H.9)', (provider) => {
  it.each(CONTACT_PAGES)('$name: no seeded contact reaches the provider', async (page) => {
    const { app, net } = await worker(provider)
    await app.inject({
      method: 'POST',
      url: '/extract',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ input: page.text, tableVersion: EXTRACTION_TABLE_VERSION }),
    })
    // The request was sent at all: an empty body list would pass every check below.
    expect(net.bodies.length).toBeGreaterThan(0)
    // Egress goes to the provider's own host only (AC11 for OpenRouter).
    expect(new Set(net.hosts)).toEqual(new Set([HOSTS[provider]]))
    const sent = net.bodies.flatMap(stringsOf).join('\n')
    // The page did travel: its first line survives the strip.
    expect(sent).toContain(page.text.split('\n')[0]!.replace(/<\/?p>/g, ''))
    const seen = visible(sent)
    for (const contact of page.contacts) expect(seen, contact).not.toContain(visible(contact))
    const digits = digitsOf(sent)
    for (const phone of page.phones) expect(digits, phone).not.toContain(digitsOf(phone).slice(-9))
    expect(sent).not.toContain(KEY)
  })
})
