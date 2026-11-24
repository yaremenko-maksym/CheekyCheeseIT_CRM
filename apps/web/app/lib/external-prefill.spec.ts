import type { ExternalVacancyPrefill } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodePrefill,
  encodePrefill,
  BOOKMARKLET_USED_KEY,
  bookmarkletUsed,
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
  localStorage.clear()
})

describe('encodePrefill / decodePrefill', () => {
  it('round-trips Cyrillic and emoji through base64url without padding', () => {
    const encoded = encodePrefill(payload)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePrefill(`#external=${encoded}`)).toEqual(payload)
  })

  it.each([0, 1, 2])('drops all base64 padding (JSON length + %i)', (extra) => {
    const value = { ...payload, description: `${payload.description}${'x'.repeat(extra)}` }
    const n = new TextEncoder().encode(JSON.stringify(value)).length
    const encoded = encodePrefill(value)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    // unpadded base64 of n bytes is ceil(4n / 3) characters
    expect(encoded).toHaveLength(Math.ceil((4 * n) / 3))
    expect(decodePrefill(`#external=${encoded}`)).toEqual(value)
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

  it('maps every base64 character that is unsafe in a URL, both ways', () => {
    // ASCII ? and > runs put «/» and «+» into standard base64
    const tricky = { ...payload, description: '???>>>??>>?>'.repeat(20) }
    const encoded = encodePrefill(tricky)
    expect(encoded).toContain('_')
    expect(encoded).toContain('-')
    expect(encoded).not.toMatch(/[+/=]/)
    expect(decodePrefill(`#external=${encoded}`)).toEqual(tricky)
  })

  it('needs the exact prefix, not just its length', () => {
    expect(decodePrefill(`#externaX=${encodePrefill(payload)}`)).toBeNull()
  })

  it('accepts an encoded part exactly at the cap', () => {
    // JSON ignores trailing whitespace: 24 000 bytes are exactly 32 000 base64 characters
    const json = JSON.stringify(payload)
    const padded = json + ' '.repeat(24000 - new TextEncoder().encode(json).length)
    const encoded = b64url(new TextEncoder().encode(padded))
    expect(encoded).toHaveLength(PREFILL_HASH_MAX)
    expect(decodePrefill(`#external=${encoded}`)).toEqual(payload)
  })

  it('refuses a payload with a byte that is not UTF-8, even inside valid JSON', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...payload, title: 'aXb' }))
    bytes[bytes.indexOf('X'.charCodeAt(0))] = 0xff
    expect(decodePrefill(`#external=${b64url(bytes)}`)).toBeNull()
  })
})

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('stash across login', () => {
  const hash = `#external=${encodePrefill(payload)}`

  it('stashes a valid payload, peeks without consuming, then takes it exactly once', () => {
    expect(stashPrefillFromLocation({ hash })).toBe(true)
    // the key is a contract with a tab that stashed before a deploy
    expect(sessionStorage.getItem('crm.externalPrefill')).toBe(hash)
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

describe('bookmarklet used flag', () => {
  const hash = `#external=${encodePrefill(payload)}`

  it('is set the first time a payload is taken, and stays set', () => {
    expect(bookmarkletUsed()).toBe(false)
    stashPrefillFromLocation({ hash })
    takeStashedPrefill()
    // the key is a contract with every browser that already used the bookmarklet
    expect(BOOKMARKLET_USED_KEY).toBe('crm.bookmarkletUsed')
    expect(localStorage.getItem('crm.bookmarkletUsed')).toBe('1')
    expect(bookmarkletUsed()).toBe(true)
    takeStashedPrefill()
    expect(bookmarkletUsed()).toBe(true)
  })

  it('stays unset when there was nothing to take', () => {
    expect(takeStashedPrefill()).toBeNull()
    expect(bookmarkletUsed()).toBe(false)
  })

  it('reads as used when storage is unavailable, so the dialog never nags', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
    expect(bookmarkletUsed()).toBe(true)
  })

  it('still hands the payload over when the flag cannot be stored', () => {
    stashPrefillFromLocation({ hash })
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota')
      },
    })
    expect(takeStashedPrefill()).toEqual(payload)
  })
})
