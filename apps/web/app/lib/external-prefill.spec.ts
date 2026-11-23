import type { ExternalVacancyPrefill } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodePrefill,
  encodePrefill,
  hasStashedPrefill,
  PREFILL_HASH_MAX,
  PREFILL_STASH_KEY,
  stashPrefillFromLocation,
  takeStashedPrefill,
} from './external-prefill'

const payload: ExternalVacancyPrefill = {
  v: 1,
  recognition: 'partial',
  url: 'https://robota.example.ua/vacancy/7?ref=a+b/c',
  title: 'Розробник React — Senior',
  company: 'ТОВ «Сир»',
  description: 'Опис вакансії: ґ, є, ї, emoji 🧀',
  status: { url: 'found', title: 'found', company: 'guessed', description: 'missing' },
}

const hashOf = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const b64 = btoa(String.fromCharCode(...bytes))
  return `#external=${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('encodePrefill / decodePrefill', () => {
  it('round-trips Cyrillic and emoji through base64url without padding', () => {
    const encoded = encodePrefill(payload)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePrefill(`#external=${encoded}`)).toEqual(payload)
  })

  it('round-trips a long Cyrillic description that stays under the hash cap', () => {
    const long = { ...payload, description: 'ї'.repeat(10000) }
    const encoded = encodePrefill(long)
    expect(encoded.length).toBeLessThanOrEqual(PREFILL_HASH_MAX)
    expect(decodePrefill(`#external=${encoded}`)).toEqual(long)
  })

  it('encodes a 32 000-char Cyrillic description without a stack overflow, and refuses it as oversized', () => {
    const huge = { ...payload, description: 'ж'.repeat(32000) }
    const encoded = encodePrefill(huge)
    expect(encoded.length).toBeGreaterThan(PREFILL_HASH_MAX)
    expect(decodePrefill(`#external=${encoded}`)).toBeNull()
  })

  it.each([
    ['not base64', '#external=%%%'],
    ['another hash', '#other=1'],
    ['empty payload', '#external='],
    ['no hash', ''],
    ['base64 of non-JSON', `#external=${btoa('hello')}`],
    ['invalid UTF-8', `#external=${btoa('\xff\xfe')}`],
  ])('returns null for %s', (_label, hash) => {
    expect(decodePrefill(hash)).toBeNull()
  })

  it('returns null for JSON that is not a prefill', () => {
    expect(decodePrefill(hashOf({ v: 2 }))).toBeNull()
  })

  it('cuts an over-long title, drops an unsafe link and strips unknown keys', () => {
    const decoded = decodePrefill(
      hashOf({ ...payload, title: 'a'.repeat(501), url: 'javascript:alert(1)', extra: 1 }),
    )
    expect(decoded?.title).toHaveLength(500)
    expect(decoded?.url).toBeUndefined()
    expect(decoded?.status.url).toBe('missing')
    expect(decoded).not.toHaveProperty('extra')
  })

  it('refuses an encoded part one character over the cap', () => {
    expect(decodePrefill(`#external=${'A'.repeat(PREFILL_HASH_MAX + 1)}`)).toBeNull()
  })
})

describe('stash across login', () => {
  const hash = `#external=${encodePrefill(payload)}`

  it('stashes a valid payload, peeks without consuming, then takes it exactly once', () => {
    expect(stashPrefillFromLocation({ hash })).toBe(true)
    expect(hasStashedPrefill()).toBe(true)
    expect(hasStashedPrefill()).toBe(true)
    expect(takeStashedPrefill()).toEqual(payload)
    expect(takeStashedPrefill()).toBeNull()
    expect(hasStashedPrefill()).toBe(false)
  })

  it('does not stash an invalid hash', () => {
    expect(stashPrefillFromLocation({ hash: '#external=%%%' })).toBe(false)
    expect(sessionStorage.getItem(PREFILL_STASH_KEY)).toBeNull()
  })

  it('an invalid stashed value yields null and is removed', () => {
    sessionStorage.setItem(PREFILL_STASH_KEY, '#external=garbage!')
    expect(takeStashedPrefill()).toBeNull()
    expect(sessionStorage.getItem(PREFILL_STASH_KEY)).toBeNull()
  })

  it('storage errors are false / null, never a throw', () => {
    const fail = () => {
      throw new Error('denied')
    }
    vi.stubGlobal('sessionStorage', { getItem: fail, setItem: fail, removeItem: fail })
    expect(stashPrefillFromLocation({ hash })).toBe(false)
    expect(hasStashedPrefill()).toBe(false)
    expect(takeStashedPrefill()).toBeNull()
  })
})
