import { describe, expect, it, vi } from 'vitest'
import { safeCall } from './safe-call'

describe('safeCall', () => {
  it('runs the function normally when it does not throw', () => {
    const fn = vi.fn()
    safeCall(fn, 'test-context')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('swallows a thrown Error — never rethrows', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    expect(() =>
      safeCall(() => {
        throw new Error('boom')
      }, 'test-context'),
    ).not.toThrow()
    debugSpy.mockRestore()
  })

  it('logs via console.debug (not console.error — fail-silent, no red noise)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    safeCall(() => {
      throw new Error('boom')
    }, 'test-context')
    expect(debugSpy).toHaveBeenCalledOnce()
    expect(debugSpy.mock.calls[0]?.[0]).toContain('test-context')
    expect(errorSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('swallows a thrown non-Error value too (string/object throw)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    expect(() =>
      safeCall(() => {
        throw 'a string throw'
      }, 'weird-throw'),
    ).not.toThrow()
    debugSpy.mockRestore()
  })
})
