import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import {
  createFileRouteStatePort,
  createMemoryRouteStatePort,
  createOwnCapPort,
  EMPTY_ROUTE_STATE,
  isProviderBlocked,
  isRetired,
  isSpent,
  markAuth,
  markCredit,
  markRetired,
  markSpent,
  MAX_STATE_BYTES,
  MAX_STATE_ENTRIES,
  providerDay,
  type RouteState,
  type StateEvent,
} from './state'

const PATH = '/data/route-state.json'
/** 2026-11-04T12:00Z: the same calendar day in UTC and Pacific. */
const NOON = Date.parse('2026-11-04T12:00:00Z')

const doc = (s: Partial<RouteState>) => JSON.stringify({ ...EMPTY_ROUTE_STATE, ...s })

async function load(text: string | undefined, now = () => NOON) {
  const fs = fakeFs(text === undefined ? {} : { [PATH]: text })
  const events: StateEvent[] = []
  const port = await createFileRouteStatePort({
    path: PATH,
    fs,
    now,
    onEvent: (e) => events.push(e),
  })
  return { fs, port, events }
}

describe('providerDay (§5.1 resets)', () => {
  it('Groq resets at midnight UTC, Gemini at midnight Pacific', () => {
    const instant = Date.parse('2026-11-04T05:00:00Z')
    expect(providerDay('groq', instant)).toBe('2026-11-04')
    expect(providerDay('gemini', instant)).toBe('2026-11-03')
    expect(providerDay('gemini', Date.parse('2026-11-04T08:00:00Z'))).toBe('2026-11-04')
  })
})

describe('memory RouteStatePort', () => {
  it('applies every change and reports the write as done', async () => {
    const port = createMemoryRouteStatePort()
    expect(await port.update(markRetired('groq', 'openai/gpt-oss-20b', NOON))).toBe(true)
    expect(isRetired(port.snapshot(), 'groq', 'openai/gpt-oss-20b')).toBe(true)
    expect(port.snapshot().retired[0]?.at).toBe('2026-11-04T12:00:00.000Z')
  })
})

describe('file RouteStatePort: reading (§3.2, SR-M-6)', () => {
  it('a missing file is empty state without an event', async () => {
    const { port, events } = await load(undefined)
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([])
  })

  it('loads a valid file', async () => {
    const valid = doc({
      retired: [
        {
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          code: 'RETIRED',
          at: '2026-11-01T00:00:00Z',
        },
      ],
    })
    const { port, events } = await load(valid)
    expect(isRetired(port.snapshot(), 'gemini', 'gemini-2.0-flash')).toBe(true)
    expect(events).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{"version":1,'],
    ['JSON that is not an object', '[]'],
    [
      'a provider outside the allowlist',
      doc({ spent: [{ provider: 'openrouter', model: 'x', day: '2026-11-04' } as never] }),
    ],
    [
      'an invalid model id',
      doc({ spent: [{ provider: 'groq', model: '../../etc/passwd', day: '2026-11-04' }] }),
    ],
    [
      'a model outside the family',
      doc({ spent: [{ provider: 'groq', model: 'llama-3.1-8b-instant', day: '2026-11-04' }] }),
    ],
    [
      'an unknown code',
      doc({
        retired: [
          {
            provider: 'groq',
            model: 'openai/gpt-oss-20b',
            code: 'GONE',
            at: '2026-11-04T00:00:00Z',
          } as never,
        ],
      }),
    ],
    ['a joined provider:model string', doc({ retired: ['groq:openai/gpt-oss-20b' as never] })],
    ['a foreign field', JSON.stringify({ ...EMPTY_ROUTE_STATE, reason: 'body text' })],
    [
      'a bad day',
      doc({ spent: [{ provider: 'groq', model: 'openai/gpt-oss-20b', day: 'today' }] }),
    ],
    [
      'too many entries',
      doc({
        spent: Array.from({ length: MAX_STATE_ENTRIES + 1 }, () => ({
          provider: 'groq' as const,
          model: 'openai/gpt-oss-20b',
          day: '2026-11-04',
        })),
      }),
    ],
  ])('rejects the whole file with %s and raises STATE_RESET', async (_label, text) => {
    const { port, events } = await load(text)
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'invalid' }])
  })

  it('an oversized file is rejected before it is read', async () => {
    const big = doc({}) + ' '.repeat(MAX_STATE_BYTES)
    const { port, events } = await load(big)
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'oversized' }])
  })

  it('a file of exactly the ceiling is read', async () => {
    const text = doc({})
    const { events } = await load(text + ' '.repeat(MAX_STATE_BYTES - text.length))
    expect(events).toEqual([])
  })

  it('an unreadable file is empty state with an event', async () => {
    const fs = fakeFs({ [PATH]: doc({}) })
    fs.statError = 'EACCES'
    const events: StateEvent[] = []
    const port = await createFileRouteStatePort({
      path: PATH,
      fs,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    })
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'unreadable' }])
  })

  it('prunes spent entries of past provider days on load and keeps today and a skewed future day', async () => {
    const spent = [
      { provider: 'groq' as const, model: 'openai/gpt-oss-20b', day: '2026-11-03' },
      { provider: 'groq' as const, model: 'openai/gpt-oss-120b', day: '2026-11-04' },
      { provider: 'gemini' as const, model: 'gemini-2.5-flash', day: '2026-11-05' },
    ]
    const { port } = await load(doc({ spent }))
    expect(port.snapshot().spent.map((e) => e.day)).toEqual(['2026-11-04', '2026-11-05'])
  })
})

describe('file RouteStatePort: writing', () => {
  it('writes through by durable atomic replace: 0600 temp, fsync, rename, directory fsync', async () => {
    const { fs, port } = await load(undefined)
    expect(await port.update(markAuth('groq'))).toBe(true)
    expect(fs.calls).toEqual([
      `open ${PATH}.tmp w`,
      `write ${PATH}.tmp`,
      `sync ${PATH}.tmp`,
      `close ${PATH}.tmp`,
      `rename ${PATH}.tmp ${PATH}`,
      'open /data r',
      'sync /data',
      'close /data',
    ])
    expect(fs.modes.get(`${PATH}.tmp`)).toBe(0o600)
    expect(JSON.parse(fs.files.get(PATH)!)).toMatchObject({
      providers: [{ provider: 'groq', auth: true }],
    })
  })

  it('two concurrent changes both survive (single serialised writer)', async () => {
    const { fs, port } = await load(undefined)
    await Promise.all([
      port.update(markRetired('groq', 'openai/gpt-oss-20b', NOON)),
      port.update(markSpent('gemini', 'gemini-2.5-flash', '2026-11-04')),
    ])
    const written = JSON.parse(fs.files.get(PATH)!) as RouteState
    expect(written.retired).toHaveLength(1)
    expect(written.spent).toHaveLength(1)
  })

  it.each(['open', 'write', 'rename'] as const)(
    'a write interrupted at %s leaves the previous file readable and keeps the change in memory',
    async (step) => {
      const before = doc({ providers: [{ provider: 'gemini', auth: true }] })
      const { fs, port, events } = await load(before)
      fs.failAt = step
      expect(await port.update(markCredit('groq', '2026-11-04'))).toBe(false)
      expect(fs.files.get(PATH)).toBe(before)
      expect(events).toEqual([{ type: 'STATE_WRITE_FAILED', store: 'route-state' }])
      expect(isProviderBlocked(port.snapshot(), 'groq', '2026-11-04')).toBe(true)
      fs.failAt = undefined
      expect(await port.update(markAuth('groq'))).toBe(true)
    },
  )

  it('a retirement survives a restart (file reloaded)', async () => {
    const { fs, port } = await load(undefined)
    await port.update(markRetired('gemini', 'gemini-2.0-flash', NOON))
    const reloaded = await createFileRouteStatePort({
      path: PATH,
      fs,
      now: () => NOON + 86_400_000 * 3,
    })
    expect(isRetired(reloaded.snapshot(), 'gemini', 'gemini-2.0-flash')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('the real file on disk has mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-state-'))
    try {
      const path = join(dir, 'state.json')
      const port = await createFileRouteStatePort({ path, now: () => NOON })
      await port.update(markAuth('groq'))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('the default fs writes and reloads a real file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-state-'))
    try {
      const path = join(dir, 'state.json')
      const port = await createFileRouteStatePort({ path, now: () => NOON })
      expect(await port.update(markSpent('groq', 'openai/gpt-oss-20b', '2026-11-04'))).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        spent: [{ day: '2026-11-04' }],
      })
      const again = await createFileRouteStatePort({ path, now: () => NOON })
      expect(isSpent(again.snapshot(), 'groq', 'openai/gpt-oss-20b', '2026-11-04')).toBe(true)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('pure state changes', () => {
  it('marks are idempotent and spent is per provider day', () => {
    const s1 = markSpent('groq', 'openai/gpt-oss-20b', '2026-11-04')(EMPTY_ROUTE_STATE)
    expect(markSpent('groq', 'openai/gpt-oss-20b', '2026-11-04')(s1)).toBe(s1)
    expect(isSpent(s1, 'groq', 'openai/gpt-oss-20b', '2026-11-04')).toBe(true)
    expect(isSpent(s1, 'groq', 'openai/gpt-oss-20b', '2026-11-05')).toBe(false)
    expect(isSpent(s1, 'groq', 'openai/gpt-oss-20b', '2026-11-03')).toBe(true)
    expect(isSpent(s1, 'gemini', 'openai/gpt-oss-20b', '2026-11-04')).toBe(false)
    expect(isSpent(s1, 'groq', 'openai/gpt-oss-120b', '2026-11-04')).toBe(false)
    const r1 = markRetired('groq', 'openai/gpt-oss-20b', NOON)(EMPTY_ROUTE_STATE)
    expect(markRetired('groq', 'openai/gpt-oss-20b', NOON + 1)(r1)).toBe(r1)
    expect(isRetired(r1, 'gemini', 'openai/gpt-oss-20b')).toBe(false)
  })

  it('CREDIT blocks a provider until its day turns; AUTH until its proof', () => {
    const credit = markCredit('groq', '2026-11-04')(EMPTY_ROUTE_STATE)
    expect(isProviderBlocked(credit, 'groq', '2026-11-04')).toBe(true)
    expect(isProviderBlocked(credit, 'groq', '2026-11-05')).toBe(false)
    expect(isProviderBlocked(credit, 'gemini', '2026-11-04')).toBe(false)
    const auth = markAuth('gemini')(credit)
    expect(isProviderBlocked(auth, 'gemini', '2099-01-01')).toBe(true)
    expect(auth.providers).toHaveLength(2)
    expect(isProviderBlocked(EMPTY_ROUTE_STATE, 'groq', '2026-11-04')).toBe(false)
  })

  it('lists are capped by dropping the oldest entries', () => {
    let s = EMPTY_ROUTE_STATE
    for (let i = 0; i < MAX_STATE_ENTRIES + 2; i++)
      s = markSpent(
        'groq',
        'openai/gpt-oss-20b',
        `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      )(s)
    expect(s.spent.length).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
  })
})

describe('OwnCapPort over the state (§3.1, §5.1 units, D5)', () => {
  const make = (
    limits = { groq: { requestsPerDay: 4 } },
    now = () => NOON,
    state = createMemoryRouteStatePort(),
  ) => ({
    cap: createOwnCapPort({ state, limits, now }),
    state,
  })

  it('grants exactly 50 % of the free request limit, then refuses', async () => {
    const { cap } = make()
    expect(await cap.reserve('groq')).toBe(true)
    expect(await cap.reserve('groq')).toBe(true)
    expect(await cap.reserve('groq')).toBe(false)
  })

  it('an odd free limit rounds the cap down', async () => {
    const { cap } = make({ groq: { requestsPerDay: 3 } })
    expect(await cap.reserve('groq')).toBe(true)
    expect(await cap.reserve('groq')).toBe(false)
  })

  it('a provider without a configured limit has a cap of zero', async () => {
    const { cap } = make()
    expect(await cap.reserve('gemini')).toBe(false)
  })

  it('concurrent reservations never exceed the cap', async () => {
    const { cap, state } = make({ groq: { requestsPerDay: 6 } })
    const granted = await Promise.all(Array.from({ length: 8 }, () => cap.reserve('groq')))
    expect(granted.filter(Boolean)).toHaveLength(3)
    expect(state.snapshot().providers[0]?.ownCap?.requests).toBe(3)
  })

  it('release gives a unit back', async () => {
    const { cap } = make()
    await cap.reserve('groq')
    await cap.reserve('groq')
    await cap.release('groq')
    expect(await cap.reserve('groq')).toBe(true)
    expect(await cap.reserve('groq')).toBe(false)
  })

  it('release never drives the count below zero', async () => {
    const { cap, state } = make()
    await cap.release('groq')
    expect(state.snapshot().providers[0]?.ownCap?.requests).toBe(0)
  })

  it('the token cap is 50 % of the free token limit', async () => {
    const { cap } = make({ groq: { requestsPerDay: 100, tokensPerDay: 1000 } } as never)
    expect(await cap.reserve('groq')).toBe(true)
    await cap.addTokens('groq', 499.9)
    expect(await cap.reserve('groq')).toBe(true)
    await cap.addTokens('groq', 1)
    expect(await cap.reserve('groq')).toBe(false)
  })

  it('negative token counts add nothing', async () => {
    const { cap, state } = make()
    await cap.addTokens('groq', -50)
    expect(state.snapshot().providers[0]?.ownCap?.tokens).toBe(0)
  })

  it('the count resets on the provider day rollover', async () => {
    let now = Date.parse('2026-11-04T23:59:00Z')
    const { cap } = make(undefined, () => now)
    await cap.reserve('groq')
    await cap.reserve('groq')
    expect(await cap.reserve('groq')).toBe(false)
    now = Date.parse('2026-11-05T00:00:01Z')
    expect(await cap.reserve('groq')).toBe(true)
  })

  it('a release after the rollover does not reopen the closed day', async () => {
    let now = Date.parse('2026-11-04T23:59:00Z')
    const { cap, state } = make(undefined, () => now)
    await cap.reserve('groq')
    now = Date.parse('2026-11-05T00:00:01Z')
    await cap.release('groq')
    expect(state.snapshot().providers[0]?.ownCap).toEqual({
      day: '2026-11-05',
      requests: 0,
      tokens: 0,
    })
  })

  it('a clock that goes back keeps the later day counting (no reset by skew)', async () => {
    let now = Date.parse('2026-11-05T01:00:00Z')
    const { cap } = make(undefined, () => now)
    await cap.reserve('groq')
    await cap.reserve('groq')
    now = Date.parse('2026-11-04T22:00:00Z')
    expect(await cap.reserve('groq')).toBe(false)
  })

  it('Gemini counts by the Pacific day', async () => {
    let now = Date.parse('2026-11-05T07:00:00Z') // still 2026-11-04 in Pacific
    const { cap } = make({ gemini: { requestsPerDay: 2 } } as never, () => now)
    expect(await cap.reserve('gemini')).toBe(true)
    expect(await cap.reserve('gemini')).toBe(false)
    now = Date.parse('2026-11-05T09:00:00Z')
    expect(await cap.reserve('gemini')).toBe(true)
  })

  it('a failed write-through refuses the request', async () => {
    const fs = fakeFs()
    const state = await createFileRouteStatePort({ path: PATH, fs, now: () => NOON })
    const cap = createOwnCapPort({
      state,
      limits: { groq: { requestsPerDay: 10 } },
      now: () => NOON,
    })
    fs.failAt = 'rename'
    expect(await cap.reserve('groq')).toBe(false)
    fs.failAt = undefined
    expect(await cap.reserve('groq')).toBe(true)
  })

  it('the count is written before the reservation resolves and survives a restart', async () => {
    const fs = fakeFs()
    const state = await createFileRouteStatePort({ path: PATH, fs, now: () => NOON })
    const cap = createOwnCapPort({
      state,
      limits: { groq: { requestsPerDay: 2 } },
      now: () => NOON,
    })
    await cap.reserve('groq')
    expect(JSON.parse(fs.files.get(PATH)!)).toMatchObject({
      providers: [{ ownCap: { requests: 1 } }],
    })
    const reloaded = await createFileRouteStatePort({ path: PATH, fs, now: () => NOON })
    const cap2 = createOwnCapPort({
      state: reloaded,
      limits: { groq: { requestsPerDay: 2 } },
      now: () => NOON,
    })
    expect(await cap2.reserve('groq')).toBe(false)
  })
})
