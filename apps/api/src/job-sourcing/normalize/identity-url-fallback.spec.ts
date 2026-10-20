import { describe, expect, it } from 'vitest'
import { buildIdentity } from './identity-key'

const base = { provider: 'JOOBLE_API', namespace: 'eu', nativeId: null } as const

type Input = Parameters<typeof buildIdentity>[0]
const keyOf = (
  url: string | null,
  identityParams: readonly string[] = [],
  over: Partial<Input> = {},
) => {
  const r = buildIdentity({ ...base, url, identityParams, ...over })
  return r.ok ? r.identity.identityKey : `FAIL:${r.reason}`
}

describe('buildIdentity: URL fallback', () => {
  it('without a native id the identity is URL-kind, with nativeId null', () => {
    const r = buildIdentity({ ...base, url: 'https://jobs.example/j/1', identityParams: [] })
    expect(r).toMatchObject({ ok: true, identity: { identityKind: 'URL', nativeId: null } })
  })

  it('a blank or unusable native id falls back to the URL instead of becoming an empty-id key', () => {
    for (const nativeId of ['', '   ', 'bad\u0000id', 'x'.repeat(257)]) {
      const r = buildIdentity({
        ...base,
        nativeId,
        url: 'https://jobs.example/j/1',
        identityParams: [],
      })
      expect(r, JSON.stringify(nativeId)).toMatchObject({
        ok: true,
        identity: { identityKind: 'URL' },
      })
    }
  })

  it('a usable native id wins: a different URL for the same id is the same identity', () => {
    const a = keyOf('https://jobs.example/j/1', [], { nativeId: '77' })
    const b = keyOf('https://jobs.example/other/path', [], { nativeId: '77' })
    expect(a).toBe(b)
    expect(a).not.toBe(keyOf('https://jobs.example/j/1'))
  })

  it('non-identity params (tracking, fetch timestamps) do not change the key; identity params do', () => {
    const plain = keyOf('https://jobs.example/view?id=1', ['id'])
    expect(keyOf('https://jobs.example/view?id=1&utm_source=x&_=1786092518', ['id'])).toBe(plain)
    expect(keyOf('https://jobs.example/view?id=2', ['id'])).not.toBe(plain)
    // Control: with no identity params declared, id is dropped — proves the param list is what matters.
    expect(keyOf('https://jobs.example/view?id=1')).toBe(keyOf('https://jobs.example/view?id=2'))
  })

  it('repeated identity params are all kept and compared as a sorted multiset', () => {
    const k = (q: string) => keyOf(`https://jobs.example/view?${q}`, ['id'])
    expect(k('id=1&id=2')).toBe(k('id=2&id=1'))
    expect(k('id=1&id=2')).not.toBe(k('id=1'))
    expect(k('id=1&id=1')).not.toBe(k('id=1'))
  })

  it('params whose VALUES contain the pair delimiters do not collide with two separate params', () => {
    // Decoded, both render as "a=1&b=2" under naive "k=v" joined by "&" — a genuine collision.
    const merged = 'https://jobs.example/view?a=1%26b%3D2'
    const split = 'https://jobs.example/view?a=1&b=2'
    expect(['a=1&b=2'].join('&')).toBe([`a=${new URL(merged).searchParams.get('a')}`].join('&'))
    expect(keyOf(merged, ['a', 'b'])).not.toBe(keyOf(split, ['a', 'b']))
  })

  it('an empty identity param value differs from an absent one', () => {
    expect(keyOf('https://jobs.example/view?id=', ['id'])).not.toBe(
      keyOf('https://jobs.example/view', ['id']),
    )
  })

  it('host spelling (case, IDN, trailing dot) and trailing slash are folded; path case is not', () => {
    const ref = keyOf('https://bücher.example/Jobs/1')
    expect(keyOf('https://XN--BCHER-KVA.example./Jobs/1/')).toBe(ref)
    expect(keyOf('https://bücher.example/jobs/1')).not.toBe(ref)
  })

  it('the same URL under another namespace or provider is another identity', () => {
    const u = 'https://jobs.example/j/1'
    expect(
      new Set([keyOf(u), keyOf(u, [], { namespace: 'us' }), keyOf(u, [], { provider: 'REED_API' })])
        .size,
    ).toBe(3)
  })

  it('quarantines when there is neither a native id nor a safe URL', () => {
    for (const url of [
      null,
      'javascript:alert(1)',
      'https://u:p@jobs.example/j',
      'https://10.0.0.1/j',
    ]) {
      expect(buildIdentity({ ...base, url, identityParams: [] }), String(url)).toEqual({
        ok: false,
        reason: 'NO_IDENTITY',
      })
    }
  })
})
