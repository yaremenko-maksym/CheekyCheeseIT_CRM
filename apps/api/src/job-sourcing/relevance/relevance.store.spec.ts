import { describe, expect, it } from 'vitest'
import { relevanceReason } from './relevance.store'

const KEY = { titleKey: 'java lead', descriptionSha256: 'abc', roles: ['BACKEND_ENGINEER'] }
const A = { seniorId: '5e000000-0000-4000-8000-000000000001', profileVersion: 'pv-a', fit: 0.5 }
const B = { seniorId: '5e000000-0000-4000-8000-000000000002', profileVersion: 'pv-b', fit: 0.75 }

describe('relevanceReason', () => {
  it('is order-insensitive', () => {
    expect(relevanceReason(KEY, [A, B])).toBe(relevanceReason(KEY, [B, A]))
  })

  it('same set gives the same reason', () => {
    expect(relevanceReason(KEY, [A, B])).toBe(relevanceReason({ ...KEY }, [{ ...A }, { ...B }]))
  })

  it('two different fit sets give different reasons', () => {
    expect(relevanceReason(KEY, [A, B])).not.toBe(relevanceReason(KEY, [A, { ...B, fit: 0.5 }]))
    expect(relevanceReason(KEY, [A])).not.toBe(relevanceReason(KEY, [A, B]))
  })

  it('a re-grade after a profile change gives a new reason even at the same fit', () => {
    expect(relevanceReason(KEY, [A])).not.toBe(
      relevanceReason(KEY, [{ ...A, profileVersion: 'pv-a2' }]),
    )
  })

  it('a re-grade after the vacancy key moved gives a new reason even at the same fits', () => {
    const base = relevanceReason(KEY, [A])
    expect(relevanceReason({ ...KEY, roles: ['FULLSTACK_ENGINEER'] }, [A])).not.toBe(base)
    expect(relevanceReason({ ...KEY, descriptionSha256: null }, [A])).not.toBe(base)
    expect(relevanceReason({ ...KEY, titleKey: 'java dev' }, [A])).not.toBe(base)
  })

  it('starts with RELEVANCE:rel.1: then 16 hex, and is ≤ 100 chars', () => {
    const r = relevanceReason(KEY, [A, B])
    expect(r).toMatch(/^RELEVANCE:rel\.1:[0-9a-f]{16}$/)
    expect(r.length).toBeLessThanOrEqual(100)
  })

  it('never starts with AVAILABILITY:', () => {
    expect(relevanceReason(KEY, []).startsWith('AVAILABILITY:')).toBe(false)
  })
})
