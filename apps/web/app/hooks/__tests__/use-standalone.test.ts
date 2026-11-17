/**
 * use-standalone.ts — unit tests (Task 0.7 PWA hardening).
 *
 * Pins:
 * 1. true when the display-mode: standalone media query matches (Android, desktop PWA).
 * 2. true when navigator.standalone is true and the media query does not match (iOS home-screen launch).
 * 3. false in a plain browser tab.
 * 4. Re-renders to true when the display mode changes while mounted.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStandalone } from '../use-standalone'

type Listener = () => void

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    matches,
    media: '(display-mode: standalone)',
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    setMatches(next: boolean) {
      query.matches = next
      listeners.forEach((listener) => listener())
    },
  }
}

function setIosStandalone(value: boolean) {
  Object.defineProperty(window.navigator, 'standalone', { value, configurable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window.navigator as { standalone?: boolean }).standalone
})

describe('useStandalone', () => {
  it('is true when the display-mode: standalone media query matches', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useStandalone())
    expect(result.current).toBe(true)
  })

  it('is true on iOS when navigator.standalone is set and the media query does not match', () => {
    stubMatchMedia(false)
    setIosStandalone(true)
    const { result } = renderHook(() => useStandalone())
    expect(result.current).toBe(true)
  })

  it('is false in a plain browser tab', () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useStandalone())
    expect(result.current).toBe(false)
  })

  it('updates when the display mode changes while mounted', () => {
    const media = stubMatchMedia(false)
    const { result } = renderHook(() => useStandalone())
    expect(result.current).toBe(false)
    act(() => media.setMatches(true))
    expect(result.current).toBe(true)
  })
})
