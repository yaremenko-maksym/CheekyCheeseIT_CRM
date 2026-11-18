/**
 * use-standalone.ts — unit tests (Task 0.7 PWA hardening).
 *
 * Pins:
 * 1. true when the display-mode: standalone media query matches (Android, desktop PWA).
 * 2. true when navigator.standalone is true and the media query does not match (iOS home-screen launch).
 * 3. false in a plain browser tab.
 * 4. Re-renders to true when the display mode changes while mounted.
 * 5. Removes its 'change' listener on unmount.
 * 6. Server snapshot is false, whatever the media query says (SSR / hydration contract).
 */
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStandalone } from '../use-standalone'

const STANDALONE_QUERY = '(display-mode: standalone)'

type Listener = () => void

function stubMatchMedia(matches: boolean) {
  const listeners = new Map<string, Set<Listener>>()
  function listenersOf(type: string): Set<Listener> {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    return set
  }
  const query = {
    matches,
    media: STANDALONE_QUERY,
    addEventListener: (type: string, listener: Listener) => listenersOf(type).add(listener),
    removeEventListener: (type: string, listener: Listener) => listenersOf(type).delete(listener),
  }
  // Any other query gets an inert object, so a wrong query string cannot reach the real listeners.
  const inert = (media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => (media === STANDALONE_QUERY ? query : inert(media))),
  )
  return {
    setMatches(next: boolean) {
      query.matches = next
      listenersOf('change').forEach((listener) => listener())
    },
    changeListenerCount: () => listenersOf('change').size,
  }
}

function setIosStandalone(value: boolean) {
  Object.defineProperty(window.navigator, 'standalone', { value, configurable: true })
}

function StandaloneProbe() {
  return createElement('span', null, String(useStandalone()))
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

  it('removes its change listener on unmount', () => {
    const media = stubMatchMedia(false)
    const { unmount } = renderHook(() => useStandalone())
    expect(media.changeListenerCount()).toBe(1)
    unmount()
    expect(media.changeListenerCount()).toBe(0)
  })

  it('server snapshot is false even when the display-mode query matches', () => {
    stubMatchMedia(true)
    expect(renderToString(createElement(StandaloneProbe))).toBe('<span>false</span>')
  })
})
