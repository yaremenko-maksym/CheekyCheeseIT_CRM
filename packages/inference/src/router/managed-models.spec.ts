import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import { createFileManagedModels, MANAGED_LIST_TARGET, pinnedModelsOnly } from './managed-models'
import { MAX_STATE_BYTES, type StateEvent } from './state'

const PATH = '/data/managed-models.json'
const PINNED = ['openai/gpt-oss-20b'] as const

function reader(text?: string) {
  const fs = fakeFs(text === undefined ? {} : { [PATH]: text })
  const events: StateEvent[] = []
  return { read: createFileManagedModels({ path: PATH, fs, onEvent: (e) => events.push(e) }), events, fs }
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
    const { read } = reader(doc({ groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], gemini: ['gemini-2.5-flash'] }))
    expect(await read('groq', PINNED)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b'])
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
    ['a provider outside the allowlist', doc({ openrouter: ['x'] })],
    ['a promotion flag', JSON.stringify({ version: 1, providers: {}, promoted: ['x'] })],
    ['too many ids', doc({ groq: Array.from({ length: MANAGED_LIST_TARGET + 1 }, () => 'openai/gpt-oss-20b') })],
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
    fs.statError = 'EACCES'
    expect(await read('groq', PINNED)).toBe(PINNED)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'managed-list', reason: 'unreadable' }])
  })
})
