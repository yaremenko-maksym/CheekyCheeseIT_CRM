import { describe, expect, it } from 'vitest'
import { geminiListing, groqListing, G1, Q1, refreshWorld } from './__test-helpers__/refresh-world'
import {
  answer,
  KEY_MARKER,
  PROVIDER_BODY_MARKER,
  TEXT_MARKER,
  type Reply,
} from './__test-helpers__/router-harness'
import { EMPTY_ROUTE_STATE, markAuth } from './state'
import {
  runDailyModelRefresh,
  runModelChainCheck,
  runStartupModelRefresh,
  type ModelRefreshResult,
} from './model-refresh'

const MARKERS = [KEY_MARKER, TEXT_MARKER, PROVIDER_BODY_MARKER, 'Bearer']
const LEAKY = `${PROVIDER_BODY_MARKER} ${KEY_MARKER} ${TEXT_MARKER} Bearer`
const error = (extra: object = {}) => JSON.stringify({ error: { message: LEAKY, ...extra } })

const FAILURES: [string, Reply][] = [
  ['401', { status: 401, body: error() }],
  ['402', { status: 402, body: error() }],
  ['403', { status: 403, body: error() }],
  ['404', { status: 404, body: error() }],
  ['429', { status: 429, body: error() }],
  ['500', { status: 500, body: error() }],
  ['503', { status: 503, body: error() }],
  ['non-JSON 200', { status: 200, body: LEAKY }],
  ['a refusal', answer(LEAKY, {}, 'content_filter')],
  ['a truncated answer', answer(LEAKY, {}, 'length')],
  ['a dropped connection', 'network'],
]
const JOBS = [
  ['daily', runDailyModelRefresh],
  ['chain', runModelChainCheck],
  ['startup', runStartupModelRefresh],
] as const

function assertClean(w: ReturnType<typeof refreshWorld>, result: ModelRefreshResult) {
  const output = [
    JSON.stringify(w.events),
    JSON.stringify(w.storeEvents),
    JSON.stringify(result),
    JSON.stringify(w.state.snapshot()),
    w.fileText() ?? '',
  ].join('\n')
  expect(w.sent.length + w.events.length).toBeGreaterThan(0)
  for (const marker of MARKERS) expect(output).not.toContain(marker)
}

describe('no key, header or body text in any event, result, state or file (AC6)', () => {
  const start = markAuth('groq')(markAuth('gemini')(EMPTY_ROUTE_STATE))

  describe.each(JOBS)('the %s job', (_name, job) => {
    it.each(FAILURES)('a chat reply of %s leaves no trace', async (_label, reply) => {
      const w = refreshWorld({ state: start, chat: () => reply })
      assertClean(w, await job(w.deps))
    })

    it.each(FAILURES)('a listing reply of %s leaves no trace', async (_label, reply) => {
      const w = refreshWorld({ state: start, listing: { gemini: reply, groq: reply } })
      assertClean(w, await job(w.deps))
    })

    it('a thrown error of a dependency leaves no trace', async () => {
      const w = refreshWorld({ state: start })
      w.deps.managedModels = async () => {
        throw new Error(LEAKY)
      }
      assertClean(w, await job(w.deps))
    })
  })

  it('a listing naming a marker as an id leaves no trace', async () => {
    const w = refreshWorld({
      listing: {
        gemini: geminiListing([
          [G1, 1_000_000],
          [KEY_MARKER, 1_000_000],
          [LEAKY, 1_000_000],
        ]),
        groq: groqListing([
          [Q1, 131_072],
          [KEY_MARKER, 131_072],
          [LEAKY, 131_072],
        ]),
      },
    })
    const result = await runDailyModelRefresh(w.deps)
    assertClean(w, result)
    expect(JSON.stringify(w.sent.map((s) => s.body))).not.toContain(KEY_MARKER)
  })

  it('the key never reaches a request body or a URL', async () => {
    const w = refreshWorld({ state: start })
    await runStartupModelRefresh(w.deps)
    await runDailyModelRefresh(w.deps)
    await runModelChainCheck(w.deps)
    expect(w.sent.length).toBeGreaterThan(0)
    for (const s of w.sent) {
      expect(s.url).not.toContain(KEY_MARKER)
      expect(JSON.stringify(s.body)).not.toContain(KEY_MARKER)
    }
  })
})
