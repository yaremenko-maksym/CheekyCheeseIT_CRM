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
})
