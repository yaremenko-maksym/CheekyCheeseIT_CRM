/**
 * useCoarsePointer — media-query-based touch/coarse-pointer detection
 * (docs/design/landing-redesign.md §M v3.3 п.2). Fakes `window.matchMedia`
 * with a controllable listener registry so tests can flip the "match" state
 * mid-test, same shape as the browser's real `MediaQueryList` API.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCoarsePointer } from '@/lib/use-coarse-pointer'

interface FakeMql {
  matches: boolean
  listeners: Set<() => void>
}

function installMatchMedia(initialMatches: boolean): FakeMql {
  const fake: FakeMql = { matches: initialMatches, listeners: new Set() }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return fake.matches
      },
      addEventListener: (_event: string, handler: () => void) => {
        fake.listeners.add(handler)
      },
      removeEventListener: (_event: string, handler: () => void) => {
        fake.listeners.delete(handler)
      },
    })),
  )
  return fake
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCoarsePointer', () => {
  it('returns true when the media query matches on mount', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
  })

  it('returns false when the media query does not match on mount', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
  })

  it('reacts to a "change" event (e.g. DevTools device emulation toggled mid-session)', () => {
    const fake = installMatchMedia(false)
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)

    act(() => {
      fake.matches = true
      fake.listeners.forEach((handler) => handler())
    })

    expect(result.current).toBe(true)
  })

  it('removes its change listener on unmount', () => {
    const fake = installMatchMedia(false)
    const { unmount } = renderHook(() => useCoarsePointer())
    expect(fake.listeners.size).toBe(1)
    unmount()
    expect(fake.listeners.size).toBe(0)
  })
})
