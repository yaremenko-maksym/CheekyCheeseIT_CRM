import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import {
  createFileManagedModels,
  createManagedListWriter,
  isPromoted,
  MANAGED_LIST_TARGET,
  pinnedModelsOnly,
} from './managed-models'
import {
  createMemoryRouteStatePort,
  EMPTY_ROUTE_STATE,
  MAX_STATE_BYTES,
  PROMOTION_STREAK,
  type ProbationEntry,
  type StateEvent,
} from './state'

const PATH = '/data/managed-models.json'
const PINNED = ['openai/gpt-oss-20b'] as const

function reader(text?: string) {
  const fs = fakeFs(text === undefined ? {} : { [PATH]: text })
  const events: StateEvent[] = []
  return {
    read: createFileManagedModels({
      path: PATH,
      fs,
      state: createMemoryRouteStatePort(EMPTY_ROUTE_STATE),
      onEvent: (e) => events.push(e),
    }),
    events,
    fs,
  }
}

const doc = (providers: object) => JSON.stringify({ version: 1, providers })

describe('managedModels reader (ADR §3.4)', () => {
  it('pinnedModelsOnly always serves the fallback', async () => {
    expect(await pinnedModelsOnly('groq', PINNED)).toBe(PINNED)
  })

  it('a missing file serves the pinned fallback without an event', async () => {
    const { read, events } = reader()
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(events).toEqual([])
  })

  it('serves a valid managed entry in its stored order', async () => {
    const { read } = reader(
      doc({ groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], gemini: ['gemini-2.5-flash'] }),
    )
    // Both pinned here, so the promotion order leaves the stored order alone.
    expect(await read('groq', ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'])).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ])
    expect(await read('gemini', ['gemini-2.0-flash'])).toEqual(['gemini-2.5-flash'])
  })

  it('an absent or empty provider entry serves the fallback', async () => {
    const { read, events } = reader(doc({ groq: [] }))
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(await read('gemini', ['gemini-2.5-flash'])).toEqual(['gemini-2.5-flash'])
    expect(events).toEqual([])
  })

  it('re-reads the file on every call, so a refresh is picked up', async () => {
    const { read, fs } = reader(doc({ groq: ['openai/gpt-oss-120b'] }))
    expect(await read('groq', PINNED)).toEqual(['openai/gpt-oss-120b'])
    fs.files.set(PATH, doc({ groq: ['openai/gpt-oss-20b'] }))
    expect(await read('groq', PINNED)).toEqual(['openai/gpt-oss-20b'])
  })

  it.each([
    ['corrupt JSON', '{'],
    ['an id outside the family', doc({ groq: ['llama-3.1-8b-instant'] })],
    ['a hostile id', doc({ gemini: ['../../x'] })],
    ['a Groq id under Gemini', doc({ gemini: ['openai/gpt-oss-20b'] })],
    ['one bad id among good ones', doc({ groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-7b'] })],
    [
      'a bad provider list beside a good one',
      doc({ groq: ['openai/gpt-oss-20b'], gemini: ['gemini-x'] }),
    ],
    ['a provider outside the allowlist', doc({ openrouter: ['x'] })],
    ['a promotion flag', JSON.stringify({ version: 1, providers: {}, promoted: ['x'] })],
    [
      'too many ids',
      doc({ groq: Array.from({ length: MANAGED_LIST_TARGET + 1 }, () => 'openai/gpt-oss-20b') }),
    ],
    ['a repeated id', doc({ groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-20b'] })],
    [
      'a repeated id beside a good list',
      doc({ groq: ['openai/gpt-oss-20b'], gemini: ['gemini-2.5-flash', 'gemini-2.5-flash'] }),
    ],
    ['a wrong version', JSON.stringify({ version: 2, providers: {} })],
  ])('rejects the whole file with %s: fallback and STATE_RESET', async (_label, text) => {
    const { read, events } = reader(text)
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'invalid' }])
  })

  it('an oversized file serves the fallback', async () => {
    const { read, events } = reader(doc({}) + ' '.repeat(MAX_STATE_BYTES))
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'oversized' }])
  })

  it('an unreadable file serves the fallback', async () => {
    const { read, events, fs } = reader(doc({}))
    fs.openError = 'EACCES'
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'unreadable' }])
  })
})

describe('promotion is recomputed, never read from the file (§3.4, SR-M-9)', () => {
  const OLD = 'gemini-2.5-flash'
  const NEW = 'gemini-3.0-flash'
  const entry = (model: string, aliveStreak: number): ProbationEntry => ({
    provider: 'gemini',
    model,
    aliveStreak,
    lastProbeDay: '2026-11-04',
  })
  const read = (list: string[], probation?: ProbationEntry[]) => {
    const fs = fakeFs({ [PATH]: doc({ gemini: list }) })
    const state = createMemoryRouteStatePort({
      ...EMPTY_ROUTE_STATE,
      ...(probation === undefined ? {} : { probation }),
    })
    return createFileManagedModels({ path: PATH, fs, state, onEvent: () => undefined })('gemini', [
      OLD,
    ])
  }

  it('an entry absent from pinned and without a full streak serves below a promoted one', async () => {
    expect(await read([NEW, OLD], [entry(NEW, PROMOTION_STREAK - 1)])).toEqual([OLD, NEW])
  })

  it('an entry with no record at all is on probation', async () => {
    expect(await read([NEW, OLD])).toEqual([OLD, NEW])
  })

  it('a full streak promotes it, and the file order then holds', async () => {
    expect(await read([NEW, OLD], [entry(NEW, PROMOTION_STREAK)])).toEqual([NEW, OLD])
  })

  it('a full streak of another model promotes nothing here', async () => {
    expect(await read([NEW, OLD], [entry('gemini-9.0-flash', PROMOTION_STREAK)])).toEqual([
      OLD,
      NEW,
    ])
  })

  it('keeps file order inside each group', async () => {
    const ids = ['gemini-5.0-flash', 'gemini-6.0-flash', 'gemini-7.0-flash', OLD]
    expect(await read(ids, [entry('gemini-7.0-flash', PROMOTION_STREAK)])).toEqual([
      'gemini-7.0-flash',
      OLD,
      'gemini-5.0-flash',
      'gemini-6.0-flash',
    ])
  })

  it('a reader without a state port does not compile: the file order is never trusted', () => {
    // @ts-expect-error `state` is required (SR-M-3); `tsc --noEmit` fails here when it is optional.
    createFileManagedModels({ path: PATH, onEvent: () => undefined })
  })

  it('isPromoted reads pinned or a full streak of this model, nothing else', () => {
    expect(isPromoted(OLD, [OLD], [])).toBe(true)
    expect(isPromoted(NEW, [OLD], [entry(NEW, PROMOTION_STREAK)])).toBe(true)
    expect(isPromoted(NEW, [OLD], [entry(NEW, PROMOTION_STREAK - 1)])).toBe(false)
    expect(isPromoted(NEW, [OLD], [entry(OLD, PROMOTION_STREAK)])).toBe(false)
    expect(isPromoted(NEW, [OLD], [])).toBe(false)
  })
})

describe('the managed-list writer (SR-M-6)', () => {
  const G = 'gemini-2.5-flash'
  const Q = 'openai/gpt-oss-20b'

  function writer(text?: string) {
    const fs = fakeFs(text === undefined ? {} : { [PATH]: text })
    const events: StateEvent[] = []
    const write = createManagedListWriter({ path: PATH, fs, onEvent: (e) => events.push(e) })
    return { fs, events, write }
  }

  it('creates the file at mode 0600 through a temp file and a rename', async () => {
    const { fs, write } = writer()
    expect(await write('groq', [Q])).toBe(true)
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({ version: 1, providers: { groq: [Q] } })
    expect(fs.modes.get(fs.tempNames[0]!)).toBe(0o600)
    expect(fs.calls.some((c) => c.startsWith('rename '))).toBe(true)
  })

  it('keeps the list of the other provider', async () => {
    const { fs, write } = writer(doc({ gemini: [G] }))
    expect(await write('groq', [Q])).toBe(true)
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({
      version: 1,
      providers: { gemini: [G], groq: [Q] },
    })
  })

  it('an invalid file on disk gives the other provider nothing to keep', async () => {
    const { fs, write } = writer(doc({ gemini: ['../x'] }))
    expect(await write('groq', [Q])).toBe(true)
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({ version: 1, providers: { groq: [Q] } })
  })

  it('never writes an empty list: the file stays byte-identical', async () => {
    const before = doc({ groq: [Q] })
    const { fs, write } = writer(before)
    expect(await write('groq', [])).toBe(false)
    expect(fs.files.get(PATH)).toBe(before)
    expect(fs.calls).toEqual([])
  })

  it.each<[string, string[]]>([
    ['an id outside the family', ['llama-3.1-8b-instant']],
    ['a hostile id', ['../../x']],
    ['too many ids', Array.from({ length: MANAGED_LIST_TARGET + 1 }, () => Q)],
    ['a repeated id', [Q, Q]],
  ])('never writes %s: the file stays byte-identical', async (_label, ids) => {
    const before = doc({ groq: [Q] })
    const { fs, write } = writer(before)
    expect(await write('groq', ids)).toBe(false)
    expect(fs.files.get(PATH)).toBe(before)
    expect(fs.tempNames).toEqual([])
  })

  it('accepts exactly the target number of ids', async () => {
    const { write } = writer()
    expect(
      await write(
        'gemini',
        Array.from({ length: MANAGED_LIST_TARGET }, (_, i) => `gemini-${i}.0-flash`),
      ),
    ).toBe(true)
  })

  it('says nothing when it creates a file or replaces a readable one', async () => {
    const created = writer()
    expect(await created.write('groq', [Q])).toBe(true)
    expect(created.events).toEqual([])
    const replaced = writer(doc({ groq: [Q] }))
    expect(await replaced.write('groq', ['openai/gpt-oss-120b'])).toBe(true)
    expect(replaced.events).toEqual([])
  })

  describe('overwriting a file it could not read (SR-L-5)', () => {
    const NEXT = { version: 1, providers: { groq: [Q] } }

    it('says so for an oversized file, and replaces it', async () => {
      const { fs, write, events } = writer(doc({}) + ' '.repeat(MAX_STATE_BYTES))
      expect(await write('groq', [Q])).toBe(true)
      expect(JSON.parse(fs.files.get(PATH)!)).toEqual(NEXT)
      expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'oversized' }])
    })

    it('says so for an unreadable file, and replaces it', async () => {
      const { fs, write, events } = writer(doc({ gemini: [G] }))
      fs.openError = 'EACCES'
      expect(await write('groq', [Q])).toBe(true)
      delete fs.openError
      expect(JSON.parse(fs.files.get(PATH)!)).toEqual(NEXT)
      expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'unreadable' }])
    })

    it('says nothing when it refuses the new list: nothing was overwritten', async () => {
      const before = doc({}) + ' '.repeat(MAX_STATE_BYTES)
      const { fs, write, events } = writer(before)
      expect(await write('groq', ['../../x'])).toBe(false)
      expect(fs.files.get(PATH)).toBe(before)
      expect(events).toEqual([])
    })

    it('reports only the failed write when the replacement fails', async () => {
      const before = doc({}) + ' '.repeat(MAX_STATE_BYTES)
      const { fs, write, events } = writer(before)
      fs.failAt = 'rename'
      expect(await write('groq', [Q])).toBe(false)
      expect(fs.files.get(PATH)).toBe(before)
      expect(events).toEqual([{ type: 'STATE_WRITE_FAILED', store: 'managed-list' }])
    })
  })

  it('two concurrent writes both survive', async () => {
    const { fs, write } = writer()
    const results = await Promise.all([write('groq', [Q]), write('gemini', [G])])
    expect(results).toEqual([true, true])
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({
      version: 1,
      providers: { groq: [Q], gemini: [G] },
    })
  })

  it.each(['open', 'write', 'rename'] as const)(
    'a write failing at %s leaves the previous file readable and says so',
    async (failAt) => {
      const before = doc({ groq: [Q] })
      const { fs, write, events } = writer(before)
      fs.failAt = failAt
      expect(await write('groq', ['openai/gpt-oss-120b'])).toBe(false)
      expect(fs.files.get(PATH)).toBe(before)
      expect(events).toEqual([{ type: 'STATE_WRITE_FAILED', store: 'managed-list' }])
    },
  )

  it('the queue goes on after a failed write', async () => {
    const { fs, write } = writer()
    fs.failAt = 'rename'
    expect(await write('groq', [Q])).toBe(false)
    delete fs.failAt
    expect(await write('groq', [Q])).toBe(true)
  })
})
