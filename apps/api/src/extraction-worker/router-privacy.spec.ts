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
import { WRITING_PAYLOAD_FACTS, writingPayloadFixture } from '../test/writing-payload-fixture'
import { EXTRACTION_TABLE_VERSION, writingPayloadSchema } from './link-contract'
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

/**
 * item 460: `payload` carries one `WritingPayload` and nothing else. A key the producer never builds
 * — a name, an email, a phone, a link — is invisible to the body schema once it sits inside the
 * payload, so only the payload's own strict schema can refuse it, and the refusal has to happen
 * before a route is picked and anything leaves the process. The facts come from the one shared
 * producer-built fixture rather than a literal (AC3, CR-M-1); the headline carries this spec's
 * marker so an assertion can follow it into the provider request.
 */
const WRITE_PAYLOAD = writingPayloadFixture({
  ...WRITING_PAYLOAD_FACTS,
  headline: 'HEADLINE-MARKER-written',
})
const WRITE_ITEM = WRITE_PAYLOAD.experience[0]!
const UNKNOWN_KEYS = [
  ['name', { name: 'Jane Doe' }],
  ['email', { email: 'jane@example.com' }],
  ['phone', { phone: '+380 50 123 4567' }],
  ['link', { link: 'https://example.com/jane' }],
] as const

const write = (app: Awaited<ReturnType<typeof worker>>['app'], payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/resume-write',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ task: 'summary', payload: JSON.stringify(payload), feedback: [] }),
  })

/** The payload as a raw string: a duplicate key cannot survive `JSON.stringify` of an object. */
const writeRaw = (app: Awaited<ReturnType<typeof worker>>['app'], payload: string) =>
  app.inject({
    method: 'POST',
    url: '/resume-write',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ task: 'summary', payload, feedback: [] }),
  })

const CANONICAL = JSON.stringify(WRITE_PAYLOAD)
/**
 * `JSON.parse` keeps the LAST of two duplicate keys, so the value the schema checks is the
 * producer's own while the earlier, unchecked copy carries a contact — and it is the raw string,
 * not the parsed value, that the worker forwards to the provider.
 */
const DUPLICATE_KEYS = [
  ['at the top level', `{"headline":{"email":"jane@example.com"},${CANONICAL.slice(1)}`],
  [
    'inside an experience item',
    CANONICAL.replace('"company":', '"company":{"email":"jane@example.com"},"company":'),
  ],
] as const

describe('resume-write payload keys, with the real router behind the route (item 460)', () => {
  it.each(UNKNOWN_KEYS)(
    'a %s key at the top level of the payload gives 400 and sends nothing',
    async (_key, extra) => {
      const { app, net } = await worker('openrouter')
      const res = await write(app, { ...WRITE_PAYLOAD, ...extra })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
      expect(net.bodies).toHaveLength(0)
    },
  )

  it.each(UNKNOWN_KEYS)(
    'a %s key inside an experience item gives 400 and sends nothing',
    async (_key, extra) => {
      const { app, net } = await worker('openrouter')
      const res = await write(app, {
        ...WRITE_PAYLOAD,
        experience: [{ ...WRITE_ITEM, ...extra }],
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
      expect(net.bodies).toHaveLength(0)
    },
  )

  it.each(DUPLICATE_KEYS)('a duplicate key %s gives 400 and sends nothing', async (_where, raw) => {
    // The parsed value passes the schema on its own: only the duplicate makes this a refusal.
    expect(writingPayloadSchema.safeParse(JSON.parse(raw)).success).toBe(true)
    const { app, net } = await worker('openrouter')
    const res = await writeRaw(app, raw)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'BAD_REQUEST' })
    expect(net.bodies).toHaveLength(0)
  })

  it('positive control: the producer-built payload reaches the provider', async () => {
    const { app, net } = await worker('openrouter')
    await write(app, WRITE_PAYLOAD)
    // The request was sent at all: an empty body list would pass every check below.
    expect(net.bodies.length).toBeGreaterThan(0)
    expect(new Set(net.hosts)).toEqual(new Set([HOSTS.openrouter]))
    const sent = net.bodies.flatMap(stringsOf).join('\n')
    expect(sent).toContain(WRITE_PAYLOAD.headline)
    expect(sent).toContain('Acme Corp')
  })
})
