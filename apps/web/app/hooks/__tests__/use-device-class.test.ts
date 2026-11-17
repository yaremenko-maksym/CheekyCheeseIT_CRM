import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ByDevice, getDeviceClass, useDeviceClass } from '../use-device-class'

// Controllable fake of window.matchMedia: only `(min-width: Npx)` queries are understood.
let width = 375
const changeListeners = new Set<() => void>()

function matchesQuery(query: string): boolean {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query)
  return min !== null && width >= Number(min[1])
}

function setWidth(next: number): void {
  width = next
  for (const listener of changeListeners) listener()
}

function fakeMatchMedia(query: string): MediaQueryList {
  return {
    media: query,
    get matches() {
      return matchesQuery(query)
    },
    addEventListener: (_type: string, listener: () => void) => {
      changeListeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      changeListeners.delete(listener)
    },
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
}

beforeEach(() => {
  width = 375
  vi.stubGlobal('matchMedia', fakeMatchMedia)
})

afterEach(() => {
  cleanup()
  changeListeners.clear()
  vi.unstubAllGlobals()
})

describe('useDeviceClass', () => {
  it('maps widths to classes', () => {
    const cases: Array<[number, string]> = [
      [375, 'mobile'],
      [639, 'mobile'],
      [640, 'tablet'],
      [1023, 'tablet'],
      [1024, 'desktop'],
    ]
    for (const [px, expected] of cases) {
      setWidth(px)
      expect(getDeviceClass()).toBe(expected)
    }
  })

  it('re-renders on a media change', () => {
    const { result } = renderHook(() => useDeviceClass())
    expect(result.current).toBe('mobile')

    act(() => setWidth(1024))

    expect(result.current).toBe('desktop')
  })

  it('ByDevice mounts only one branch', () => {
    const mobileMount = vi.fn()
    const tabletMount = vi.fn()
    const desktopMount = vi.fn()
    const probe = (onMount: () => void) =>
      function Probe() {
        useEffect(() => {
          onMount()
        }, [])
        return null
      }

    render(
      createElement(ByDevice, {
        mobile: createElement(probe(mobileMount)),
        tablet: createElement(probe(tabletMount)),
        desktop: createElement(probe(desktopMount)),
      }),
    )

    expect(mobileMount).toHaveBeenCalledTimes(1)
    expect(tabletMount).not.toHaveBeenCalled()
    expect(desktopMount).not.toHaveBeenCalled()

    // tablet falls back to desktop when no tablet branch is given
    cleanup()
    setWidth(800)
    render(
      createElement(ByDevice, {
        mobile: createElement(probe(mobileMount)),
        desktop: createElement(probe(desktopMount)),
      }),
    )
    expect(desktopMount).toHaveBeenCalledTimes(1)
    expect(mobileMount).toHaveBeenCalledTimes(1)
  })

  it('same query key across classes', async () => {
    const fetcher = vi.fn(async () => 'data')
    const queryClient = new QueryClient()
    const Probe = () => {
      useQuery({ queryKey: ['x'], queryFn: fetcher, staleTime: 30_000 })
      return null
    }

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ByDevice, {
          mobile: createElement(Probe),
          tablet: createElement(Probe),
          desktop: createElement(Probe),
        }),
      ),
    )
    await waitFor(() => expect(queryClient.getQueryData(['x'])).toBe('data'))

    act(() => setWidth(1024))

    expect(queryClient.getQueryCache().findAll({ queryKey: ['x'] })).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
