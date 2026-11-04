import { constants } from 'node:fs'
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
  noFollowFlag,
  providerDay,
  STATE_READ_FLAGS,
  STATE_WRITE_FLAGS,
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
    ['a foreign field', JSON.stringify({ ...EMPTY_ROUTE_STATE, reason: 'body text' })],
    [
      'an unsafe own-cap token count',
      doc({
        providers: [
          {
            provider: 'groq',
            auth: true,
            ownCap: { day: '2026-11-04', requests: 1, tokens: 2 ** 53 },
          },
        ],
      }),
    ],
    ['a list that is not an array', JSON.stringify({ ...EMPTY_ROUTE_STATE, spent: {} })],
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

  const GOOD_SPENT = { provider: 'groq' as const, model: 'openai/gpt-oss-120b', day: '2026-11-04' }
  const GOOD_RETIRED = {
    provider: 'gemini' as const,
    model: 'gemini-2.0-flash',
    code: 'RETIRED' as const,
    at: '2026-11-01T00:00:00Z',
  }
  const PROVIDERS = [
    { provider: 'groq' as const, auth: true },
    { provider: 'gemini' as const, auth: false, creditDay: '2026-11-04' },
  ]

  it.each([
    ['a day with a prefix', { spent: [{ ...GOOD_SPENT, day: 'x2026-11-04' }] }],
    ['a day with a suffix', { spent: [{ ...GOOD_SPENT, day: '2026-11-04x' }] }],
    ['a bad day', { spent: [{ ...GOOD_SPENT, day: 'today' }] }],
    ['a model of the other provider', { spent: [{ ...GOOD_SPENT, provider: 'gemini' }] }],
    ['a provider outside the allowlist', { spent: [{ ...GOOD_SPENT, provider: 'openrouter' }] }],
    ['an invalid model id', { spent: [{ ...GOOD_SPENT, model: '../../etc/passwd' }] }],
    ['a model outside the family', { spent: [{ ...GOOD_SPENT, model: 'llama-3.1-8b-instant' }] }],
    ['an unknown code', { retired: [{ ...GOOD_RETIRED, code: 'GONE' }] }],
    ['a joined provider:model string', { retired: ['groq:openai/gpt-oss-20b'] }],
    ['a foreign field in an entry', { retired: [{ ...GOOD_RETIRED, note: 'body text' }] }],
  ])(
    'drops only the entry with %s, keeps the rest and says so (SR-L-69)',
    async (_label, bad: { spent?: unknown[]; retired?: unknown[] }) => {
      const text = JSON.stringify({
        version: 1,
        spent: [GOOD_SPENT, ...(bad.spent ?? [])],
        retired: [...(bad.retired ?? []), GOOD_RETIRED],
        providers: PROVIDERS,
      })
      const { port, events } = await load(text)
      expect(port.snapshot()).toEqual({
        version: 1,
        spent: [GOOD_SPENT],
        retired: [GOOD_RETIRED],
        providers: PROVIDERS,
      })
      expect(events).toEqual([{ type: 'STATE_ENTRIES_DROPPED', store: 'route-state', count: 1 }])
      expect(JSON.stringify(events)).not.toContain('passwd')
    },
  )

  it('counts every dropped entry across both lists', async () => {
    const text = doc({
      spent: [
        { ...GOOD_SPENT, model: 'x/../y' },
        { ...GOOD_SPENT, day: 'today' },
      ],
      retired: [{ ...GOOD_RETIRED, at: 'yesterday' }],
    })
    const { port, events } = await load(text)
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_ENTRIES_DROPPED', store: 'route-state', count: 3 }])
  })

  it('an oversized file is rejected before it is read', async () => {
    const big = doc({}) + ' '.repeat(MAX_STATE_BYTES)
    const { fs, port, events } = await load(big)
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'oversized' }])
    expect(fs.maxReadLength).toBe(0)
    expect(fs.calls).toEqual([`open ${PATH} r`, `close ${PATH}`])
  })

  it('a file that grows past the ceiling after the size check is refused, reading at most one byte over (SR-L-67)', async () => {
    const fs = fakeFs({ [PATH]: doc({}) + ' '.repeat(3 * MAX_STATE_BYTES) })
    fs.statSize = 10
    const events: StateEvent[] = []
    const port = await createFileRouteStatePort({
      path: PATH,
      fs,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    })
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'oversized' }])
    expect(fs.maxReadLength).toBe(MAX_STATE_BYTES + 1)
  })

  it('a file delivered in short reads is assembled whole', async () => {
    const fs = fakeFs({ [PATH]: doc({ retired: [] }) })
    const chunked: typeof fs.open = async (path, flags, mode) => {
      const h = await fs.open(path, flags, mode)
      return { ...h, read: (b, o, l, p) => h.read(b, o, Math.min(l, 3), p) }
    }
    const events: StateEvent[] = []
    const port = await createFileRouteStatePort({
      path: PATH,
      fs: { ...fs, open: chunked },
      now: () => NOON,
      onEvent: (e) => events.push(e),
    })
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([])
  })

  it('a read that fails after open is unreadable, and the handle is closed', async () => {
    const fs = fakeFs({ [PATH]: doc({}) })
    const failing: typeof fs.open = async (path, flags, mode) => {
      const h = await fs.open(path, flags, mode)
      return { ...h, read: async () => Promise.reject(new Error('EIO')) }
    }
    const events: StateEvent[] = []
    await createFileRouteStatePort({
      path: PATH,
      fs: { ...fs, open: failing },
      now: () => NOON,
      onEvent: (e) => events.push(e),
    })
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'unreadable' }])
    expect(fs.calls).toContain(`close ${PATH}`)
  })

  it('opens the state file for reading without following a symlink', async () => {
    const fs = fakeFs({ [PATH]: doc({}) })
    const flags: number[] = []
    const spy: typeof fs.open = (path, f, mode) => {
      flags.push(f)
      return fs.open(path, f, mode)
    }
    await createFileRouteStatePort({
      path: PATH,
      fs: { ...fs, open: spy },
      now: () => NOON,
      onEvent: () => {},
    })
    expect(flags).toEqual([STATE_READ_FLAGS])
    expect(STATE_READ_FLAGS & constants.O_WRONLY).toBe(0)
    expect(STATE_WRITE_FLAGS & constants.O_WRONLY).toBe(constants.O_WRONLY)
    expect(STATE_WRITE_FLAGS & constants.O_CREAT).toBe(constants.O_CREAT)
    expect(STATE_WRITE_FLAGS & constants.O_TRUNC).toBe(constants.O_TRUNC)
  })

  it.skipIf(constants.O_NOFOLLOW === undefined)(
    'a symlink at the state path or the temp path is refused, not followed (SR-L-67)',
    async () => {
      expect(STATE_READ_FLAGS & constants.O_NOFOLLOW!).toBe(constants.O_NOFOLLOW)
      expect(STATE_WRITE_FLAGS & constants.O_NOFOLLOW!).toBe(constants.O_NOFOLLOW)
      const fs = fakeFs({ [PATH]: doc({}) })
      fs.symlinks.add(PATH)
      fs.symlinks.add(`${PATH}.tmp`)
      const events: StateEvent[] = []
      const port = await createFileRouteStatePort({
        path: PATH,
        fs,
        now: () => NOON,
        onEvent: (e) => events.push(e),
      })
      expect(await port.update(markAuth('groq'))).toBe(false)
      expect(events).toEqual([
        { type: 'STATE_RESET', store: 'route-state', reason: 'unreadable' },
        { type: 'STATE_WRITE_FAILED', store: 'route-state' },
      ])
    },
  )

  it('a file of exactly the ceiling is read', async () => {
    const text = doc({})
    const { events } = await load(text + ' '.repeat(MAX_STATE_BYTES - text.length))
    expect(events).toEqual([])
  })

  it('the no-follow flag is the platform constant, or nothing where the platform has none', () => {
    expect(noFollowFlag({ O_NOFOLLOW: 0x20000 })).toBe(0x20000)
    expect(noFollowFlag({})).toBe(0)
  })

  it('an open that rejects with a non-error value is unreadable, not a crash', async () => {
    const fs = fakeFs({ [PATH]: doc({}) })
    const events: StateEvent[] = []
    await createFileRouteStatePort({
      path: PATH,
      fs: { ...fs, open: () => Promise.reject(null) },
      now: () => NOON,
      onEvent: (e) => events.push(e),
    })
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'unreadable' }])
  })

  it('an unreadable file is empty state with an event', async () => {
    const fs = fakeFs({ [PATH]: doc({}) })
    fs.openError = 'EACCES'
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
    expect(fs.calls).toEqual([`open ${PATH} r`])
    fs.calls.length = 0
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
      onEvent: () => {},
    })
    expect(isRetired(reloaded.snapshot(), 'gemini', 'gemini-2.0-flash')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('the real file on disk has mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-state-'))
    try {
      const path = join(dir, 'state.json')
      const port = await createFileRouteStatePort({ path, now: () => NOON, onEvent: () => {} })
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
      const port = await createFileRouteStatePort({ path, now: () => NOON, onEvent: () => {} })
      expect(await port.update(markSpent('groq', 'openai/gpt-oss-20b', '2026-11-04'))).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        spent: [{ day: '2026-11-04' }],
      })
      const again = await createFileRouteStatePort({ path, now: () => NOON, onEvent: () => {} })
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
    const dayOf = (i: number) =>
      new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    let s = EMPTY_ROUTE_STATE
    for (let i = 0; i < MAX_STATE_ENTRIES + 2; i++)
      s = markSpent('groq', 'openai/gpt-oss-20b', dayOf(i))(s)
    expect(s.spent).toHaveLength(MAX_STATE_ENTRIES)
    expect(s.spent[0]?.day).toBe(dayOf(2))
    expect(s.spent.at(-1)?.day).toBe(dayOf(MAX_STATE_ENTRIES + 1))
    let r = EMPTY_ROUTE_STATE
    for (let i = 0; i < MAX_STATE_ENTRIES + 1; i++)
      r = markRetired('gemini', `gemini-${i}.0-flash`, NOON)(r)
    expect(r.retired).toHaveLength(MAX_STATE_ENTRIES)
    expect(r.retired[0]?.model).toBe('gemini-1.0-flash')
  })
})

describe('OwnCapPort over the state (§3.1, §5.1 units, D5)', () => {
  const L4 = { requestsPerDay: 4 }
  const make = (now = () => NOON, state = createMemoryRouteStatePort()) => ({
    cap: createOwnCapPort({ state, now }),
    state,
  })
  const ownCap = (s: RouteState, p: 'groq' | 'gemini' = 'groq') =>
    s.providers.find((r) => r.provider === p)?.ownCap

  it('grants exactly 50 % of the free request limit, then refuses', async () => {
    const { cap } = make()
    expect(await cap.reserve('groq', L4)).toEqual({ day: '2026-11-04' })
    expect(await cap.reserve('groq', L4)).toEqual({ day: '2026-11-04' })
    expect(await cap.reserve('groq', L4)).toBeNull()
  })

  it('an odd free limit rounds the cap down', async () => {
    const { cap } = make()
    expect(await cap.reserve('groq', { requestsPerDay: 3 })).not.toBeNull()
    expect(await cap.reserve('groq', { requestsPerDay: 3 })).toBeNull()
  })

  it('counts each provider separately', async () => {
    const { cap } = make()
    await cap.reserve('groq', { requestsPerDay: 2 })
    expect(await cap.reserve('groq', { requestsPerDay: 2 })).toBeNull()
    expect(await cap.reserve('gemini', { requestsPerDay: 2 })).not.toBeNull()
  })

  it('concurrent reservations never exceed the cap', async () => {
    const { cap, state } = make()
    const granted = await Promise.all(
      Array.from({ length: 8 }, () => cap.reserve('groq', { requestsPerDay: 6 })),
    )
    expect(granted.filter((u) => u !== null)).toHaveLength(3)
    expect(ownCap(state.snapshot())?.requests).toBe(3)
  })

  it('release gives a unit back', async () => {
    const { cap } = make()
    const unit = (await cap.reserve('groq', L4))!
    await cap.reserve('groq', L4)
    await cap.release('groq', unit)
    expect(await cap.reserve('groq', L4)).not.toBeNull()
    expect(await cap.reserve('groq', L4)).toBeNull()
  })

  it('release never drives the count below zero', async () => {
    const { cap, state } = make()
    await cap.release('groq', { day: '2026-11-04' })
    expect(ownCap(state.snapshot())?.requests).toBe(0)
  })

  it('the token cap is 50 % of the free token limit', async () => {
    const { cap } = make()
    const limit = { requestsPerDay: 100, tokensPerDay: 1000 }
    expect(await cap.reserve('groq', limit)).not.toBeNull()
    await cap.addTokens('groq', 499.9)
    expect(await cap.reserve('groq', limit)).not.toBeNull()
    await cap.addTokens('groq', 1)
    expect(await cap.reserve('groq', limit)).toBeNull()
  })

  it.each([-50, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a token count of %s adds nothing',
    async (n) => {
      const { cap, state } = make()
      await cap.addTokens('groq', 5)
      await cap.addTokens('groq', n)
      expect(ownCap(state.snapshot())?.tokens).toBe(5)
    },
  )

  it('a token sum is clamped to a safe integer and the file still loads after a restart (SR-M-66)', async () => {
    const fs = fakeFs()
    const events: StateEvent[] = []
    const opts = { path: PATH, fs, now: () => NOON, onEvent: (e: StateEvent) => events.push(e) }
    const state = await createFileRouteStatePort(opts)
    const cap = createOwnCapPort({ state, now: () => NOON })
    await state.update(markAuth('groq'))
    await cap.addTokens('groq', 2 ** 53)
    await cap.addTokens('groq', 2 ** 53)
    expect(ownCap(state.snapshot())?.tokens).toBe(Number.MAX_SAFE_INTEGER)
    const reloaded = await createFileRouteStatePort(opts)
    expect(events).toEqual([])
    expect(ownCap(reloaded.snapshot())?.tokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(isProviderBlocked(reloaded.snapshot(), 'groq', '2026-11-04')).toBe(true)
  })

  it('the count resets on the provider day rollover', async () => {
    let now = Date.parse('2026-11-04T23:59:00Z')
    const { cap } = make(() => now)
    await cap.reserve('groq', L4)
    await cap.reserve('groq', L4)
    expect(await cap.reserve('groq', L4)).toBeNull()
    now = Date.parse('2026-11-05T00:00:01Z')
    expect(await cap.reserve('groq', L4)).toEqual({ day: '2026-11-05' })
  })

  it.each([
    ['groq', '2026-11-04T23:59:00Z', '2026-11-05T00:00:01Z', '2026-11-05'],
    ['gemini', '2026-11-05T07:59:00Z', '2026-11-05T08:00:01Z', '2026-11-05'],
  ] as const)(
    '%s: a unit reserved before midnight and released after it leaves the new day alone (SR-L-68)',
    async (p, before, after, newDay) => {
      let now = Date.parse(before)
      const { cap, state } = make(() => now)
      const limit = { requestsPerDay: 2 }
      const late = (await cap.reserve(p, limit))! // a call in flight across midnight
      now = Date.parse(after)
      const fresh = await cap.reserve(p, limit) // a concurrent call on the new day
      expect(fresh).toEqual({ day: newDay })
      await cap.release(p, late)
      expect(ownCap(state.snapshot(), p)).toEqual({ day: newDay, requests: 1, tokens: 0 })
      expect(await cap.reserve(p, limit)).toBeNull()
      await cap.release(p, fresh!)
      expect(ownCap(state.snapshot(), p)?.requests).toBe(0)
    },
  )

  it('a clock that goes back keeps the later day counting (no reset by skew)', async () => {
    let now = Date.parse('2026-11-05T01:00:00Z')
    const { cap } = make(() => now)
    await cap.reserve('groq', L4)
    const unit = await cap.reserve('groq', L4)
    now = Date.parse('2026-11-04T22:00:00Z')
    expect(await cap.reserve('groq', L4)).toBeNull()
    expect(unit).toEqual({ day: '2026-11-05' })
  })

  it('a failed write-through refuses the request', async () => {
    const fs = fakeFs()
    const opts = { path: PATH, fs, now: () => NOON, onEvent: () => {} }
    const cap = createOwnCapPort({ state: await createFileRouteStatePort(opts), now: () => NOON })
    fs.failAt = 'rename'
    expect(await cap.reserve('groq', { requestsPerDay: 10 })).toBeNull()
    fs.failAt = undefined
    expect(await cap.reserve('groq', { requestsPerDay: 10 })).not.toBeNull()
  })

  it('the count is written before the reservation resolves and survives a restart', async () => {
    const fs = fakeFs()
    const opts = { path: PATH, fs, now: () => NOON, onEvent: () => {} }
    const cap = createOwnCapPort({ state: await createFileRouteStatePort(opts), now: () => NOON })
    await cap.reserve('groq', { requestsPerDay: 2 })
    expect(JSON.parse(fs.files.get(PATH)!)).toMatchObject({
      providers: [{ ownCap: { requests: 1 } }],
    })
    const cap2 = createOwnCapPort({ state: await createFileRouteStatePort(opts), now: () => NOON })
    expect(await cap2.reserve('groq', { requestsPerDay: 2 })).toBeNull()
  })
})
