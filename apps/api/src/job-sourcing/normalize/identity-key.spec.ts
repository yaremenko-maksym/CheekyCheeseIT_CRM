import { describe, expect, it } from 'vitest'
import { buildIdentity, encodeIdentityTuple, IDENTITY_KEY_VERSION } from './identity-key'

/** A deliberately naive encoder: what we must NOT ship. Used only to prove the fixtures can collide. */
const naiveJoin = (parts: readonly string[]) => parts.join('|')

const keyOf = (input: Parameters<typeof buildIdentity>[0]): string | null => {
  const r = buildIdentity(input)
  return r.ok ? r.identity.identityKey : null
}

describe('encodeIdentityTuple: delimiter collisions', () => {
  // Each pair is two DIFFERENT component sets that a '|' join maps to ONE string.
  const collidingPairs: Array<[string, readonly string[], readonly string[]]> = [
    ['a component containing the delimiter', ['a|b', 'c'], ['a', 'b|c']],
    ['an empty component next to a populated one', ['a|', 'b'], ['a', '|b']],
    ['a component that is the concatenation of two others', ['a|b', 'c'], ['a', 'b', 'c']],
  ]

  it.each(collidingPairs)(
    'fixture collides under delimiter concatenation but the tuple encoder keeps it apart: %s',
    (_name, left, right) => {
      // Precondition: the fixture really collides under the naive encoder. If this fails the
      // fixture is decoration, not evidence.
      expect(naiveJoin(left)).toBe(naiveJoin(right))
      expect(encodeIdentityTuple(left)).not.toBe(encodeIdentityTuple(right))
    },
  )

  it('is deterministic and parses back to exactly the component list', () => {
    const parts = ['v1', 'NATIVE', 'REMOTEOK_API', 'board', 'id"with\\odd|chars']
    expect(encodeIdentityTuple(parts)).toBe(encodeIdentityTuple([...parts]))
    expect(JSON.parse(encodeIdentityTuple(parts))).toEqual(parts)
  })
})

describe('buildIdentity: native id', () => {
  const base = { provider: 'REMOTEOK_API', namespace: 'board', url: null } as const

  it('uses the native id and marks the identity NATIVE', () => {
    const r = buildIdentity({ ...base, nativeId: '12345' })
    expect(r).toMatchObject({
      ok: true,
      identity: {
        provider: 'REMOTEOK_API',
        namespace: 'board',
        nativeId: '12345',
        identityKind: 'NATIVE',
      },
    })
  })

  it('a namespace and native id that straddle the delimiter do not collide (builder level)', () => {
    const left = {
      provider: 'REMOTEOK_API',
      namespace: 'x|y',
      nativeId: 'z',
      url: null,
    } as const
    const right = {
      provider: 'REMOTEOK_API',
      namespace: 'x',
      nativeId: 'y|z',
      url: null,
    } as const
    // Precondition: delimiter-joining the REAL key layout collides for this pair. The layout is the
    // builder's own (version, kind, provider, namespace, id), so this fixture can actually fail.
    const naiveKey = (i: typeof left | typeof right) =>
      naiveJoin([IDENTITY_KEY_VERSION, 'NATIVE', i.provider, i.namespace, i.nativeId])
    expect(naiveKey(left)).toBe(naiveKey(right))
    const a = keyOf(left)
    const b = keyOf(right)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('the same id in a different namespace or provider is a different identity', () => {
    const keys = [
      keyOf({ provider: 'REMOTEOK_API', namespace: 'eu', nativeId: '1', url: null }),
      keyOf({ provider: 'REMOTEOK_API', namespace: 'us', nativeId: '1', url: null }),
      keyOf({ provider: 'DOU_RSS', namespace: 'eu', nativeId: '1', url: null }),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  it('namespace is case/NFC-insensitive, native id is case-sensitive', () => {
    expect(keyOf({ ...base, namespace: 'Board', nativeId: 'a' })).toBe(
      keyOf({ ...base, namespace: 'board', nativeId: 'a' }),
    )
    expect(keyOf({ ...base, namespace: 'café', nativeId: 'a' })).toBe(
      keyOf({ ...base, namespace: 'café', nativeId: 'a' }),
    )
    expect(keyOf({ ...base, nativeId: 'AbC' })).not.toBe(keyOf({ ...base, nativeId: 'abc' }))
  })

  it('an empty namespace is an adapter bug: quarantine, never a shared key', () => {
    expect(buildIdentity({ ...base, namespace: '  ', nativeId: '1' })).toEqual({
      ok: false,
      reason: 'INVALID_NAMESPACE',
    })
  })
})

describe('buildIdentity: persisted key layout and limits (literal expectations)', () => {
  const base = { provider: 'REMOTEOK_API', namespace: 'board', url: null } as const

  it('a native identity key is exactly [version, NATIVE, provider, namespace, id]', () => {
    expect(keyOf({ ...base, nativeId: '12345' })).toBe(
      '["v1","NATIVE","REMOTEOK_API","board","12345"]',
    )
  })

  it('a URL identity key is exactly [version, URL, provider, namespace, host, path, pairs]', () => {
    // identityParams omitted on purpose: the default is "no identity params".
    expect(keyOf({ ...base, nativeId: null, url: 'https://jobs.example/j/1/?id=7&utm=x' })).toBe(
      '["v1","URL","REMOTEOK_API","board","jobs.example","/j/1",[]]',
    )
  })

  it('accepts a namespace of exactly 128 chars and quarantines 129', () => {
    expect(buildIdentity({ ...base, namespace: 'n'.repeat(128), nativeId: '1' }).ok).toBe(true)
    expect(buildIdentity({ ...base, namespace: 'n'.repeat(129), nativeId: '1' })).toEqual({
      ok: false,
      reason: 'INVALID_NAMESPACE',
    })
  })

  it('accepts a native id of exactly 256 chars; 257 falls back to the URL', () => {
    const at = buildIdentity({ ...base, nativeId: 'i'.repeat(256) })
    expect(at).toMatchObject({ ok: true, identity: { identityKind: 'NATIVE' } })
    expect(buildIdentity({ ...base, nativeId: 'i'.repeat(257) })).toEqual({
      ok: false,
      reason: 'NO_IDENTITY',
    })
  })
})
