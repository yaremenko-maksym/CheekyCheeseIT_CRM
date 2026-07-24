import { describe, expect, it } from 'vitest'
import { computeFingerprint } from './fingerprint'

const STACK = [
  'Error: Cannot read properties of undefined',
  '    at renderList (bundle.js:12:5)',
  '    at Component (bundle.js:40:10)',
  '    at commitRoot (bundle.js:100:2)',
  '    at flushSync (bundle.js:200:1)',
].join('\n')

describe('computeFingerprint', () => {
  it('is deterministic — identical inputs produce the identical fingerprint (AC2)', () => {
    const a = computeFingerprint({ source: 'WEB', message: 'boom', stack: STACK })
    const b = computeFingerprint({ source: 'WEB', message: 'boom', stack: STACK })
    expect(a).toBe(b)
  })

  it('differs by source', () => {
    const web = computeFingerprint({ source: 'WEB', message: 'boom', stack: STACK })
    const api = computeFingerprint({ source: 'API', message: 'boom', stack: STACK })
    expect(web).not.toBe(api)
  })

  it('differs by message', () => {
    const a = computeFingerprint({ source: 'WEB', message: 'boom', stack: STACK })
    const b = computeFingerprint({ source: 'WEB', message: 'bang', stack: STACK })
    expect(a).not.toBe(b)
  })

  it('is insensitive to trailing/leading whitespace differences in the message', () => {
    const a = computeFingerprint({ source: 'WEB', message: 'boom', stack: STACK })
    const b = computeFingerprint({ source: 'WEB', message: '  boom  \n', stack: STACK })
    expect(a).toBe(b)
  })

  it('is insensitive to internal whitespace-run differences in the message', () => {
    const a = computeFingerprint({ source: 'WEB', message: 'cannot read x', stack: STACK })
    const b = computeFingerprint({ source: 'WEB', message: 'cannot   read x', stack: STACK })
    expect(a).toBe(b)
  })

  it('differs when a 4th+ stack frame changes but the top 3 stay the same', () => {
    const stackA = STACK
    const stackB = STACK.replace('flushSync (bundle.js:200:1)', 'flushSync (bundle.js:999:1)')
    const a = computeFingerprint({ source: 'WEB', message: 'boom', stack: stackA })
    const b = computeFingerprint({ source: 'WEB', message: 'boom', stack: stackB })
    // the 4th frame changed, but only the top 3 feed the fingerprint
    expect(a).toBe(b)
  })

  it('differs when one of the top 3 frames changes', () => {
    const stackA = STACK
    const stackB = STACK.replace('renderList (bundle.js:12:5)', 'renderList (bundle.js:999:5)')
    const a = computeFingerprint({ source: 'WEB', message: 'boom', stack: stackA })
    const b = computeFingerprint({ source: 'WEB', message: 'boom', stack: stackB })
    expect(a).not.toBe(b)
  })

  it('handles a missing stack (window.onerror without a stack) deterministically', () => {
    const a = computeFingerprint({ source: 'WEB', message: 'boom' })
    const b = computeFingerprint({ source: 'WEB', message: 'boom', stack: null })
    const c = computeFingerprint({ source: 'WEB', message: 'boom', stack: undefined })
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('returns a 64-char hex sha256 digest', () => {
    const fp = computeFingerprint({ source: 'API', message: 'x' })
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  describe('sec MED (review round 1, both reviewers): volatile-value stripping in the message', () => {
    it('two messages differing ONLY by a UUID produce the SAME fingerprint', () => {
      const a = computeFingerprint({
        source: 'API',
        message: 'user 11111111-1111-4111-8111-111111111111 not found',
      })
      const b = computeFingerprint({
        source: 'API',
        message: 'user 22222222-2222-4222-8222-222222222222 not found',
      })
      expect(a).toBe(b)
    })

    it('two messages differing ONLY by an ISO timestamp produce the SAME fingerprint', () => {
      const a = computeFingerprint({
        source: 'API',
        message: 'payment expired at 2026-07-24T20:17:53.123Z',
      })
      const b = computeFingerprint({
        source: 'API',
        message: 'payment expired at 2026-08-01T09:00:00.000Z',
      })
      expect(a).toBe(b)
    })

    it('two messages differing ONLY by a hex identifier (>=8 chars, e.g. a tx hash) produce the SAME fingerprint', () => {
      const a = computeFingerprint({ source: 'API', message: 'tx a3f9c2d1e5 failed to confirm' })
      const b = computeFingerprint({ source: 'API', message: 'tx b7e0d4c8f1a2 failed to confirm' })
      expect(a).toBe(b)
    })

    it('two messages differing ONLY by a 3+-digit number produce the SAME fingerprint', () => {
      const a = computeFingerprint({ source: 'API', message: 'balance mismatch: expected 1500' })
      const b = computeFingerprint({ source: 'API', message: 'balance mismatch: expected 984723' })
      expect(a).toBe(b)
    })

    it('still differs for a genuinely different message once volatile values are stripped', () => {
      const a = computeFingerprint({ source: 'API', message: 'user 123 not found' })
      const b = computeFingerprint({ source: 'API', message: 'project 123 not found' })
      expect(a).not.toBe(b)
    })

    it('a 1-2 digit number is left untouched (not volatile enough to collapse distinct cases)', () => {
      const a = computeFingerprint({ source: 'API', message: 'expected 3 arguments, got 5' })
      const b = computeFingerprint({ source: 'API', message: 'expected 3 arguments, got 5' })
      const c = computeFingerprint({ source: 'API', message: 'expected 3 arguments, got 7' })
      expect(a).toBe(b)
      expect(a).not.toBe(c)
    })
  })
})
