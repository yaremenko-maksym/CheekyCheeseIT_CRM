import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  ByDevice,
  DEVICE_QUERIES,
  getDeviceClass,
  useDeviceClass,
  type DeviceClass,
} from '../use-device-class'

const PX_PER_REM = 16
const TABLET_QUERY = '(min-width: 40rem)'
const DESKTOP_QUERY = '(min-width: 64rem)'

type Listener = () => void
type BranchName = 'mobile' | 'tablet' | 'desktop'
type Spies = Record<BranchName, Mock<() => void>>

// Controllable fake of window.matchMedia. Understands only `(min-width: Nrem)` and throws on
// anything else, so a mutated query string cannot silently evaluate to "no match".
let width = 375
let listenerCalls = 0
// query -> event type -> listeners: kept per query AND per event type, so a listener added
// with the wrong event name, or to only one query, is observable.
const registry = new Map<string, Map<string, Set<Listener>>>()

function minWidthPx(query: string): number {
  const match = /^\(min-width: (\d+)rem\)$/.exec(query)
  if (match === null) throw new Error(`fake matchMedia: unsupported query "${query}"`)
  return Number(match[1]) * PX_PER_REM
}

function matchesAt(query: string, viewport: number): boolean {
  return viewport >= minWidthPx(query)
}

function listenersOf(query: string, type: string): Set<Listener> {
  let byType = registry.get(query)
  if (byType === undefined) {
    byType = new Map()
    registry.set(query, byType)
  }
  let set = byType.get(type)
  if (set === undefined) {
    set = new Set()
    byType.set(type, set)
  }
  return set
}

function changeListenerCount(query: string): number {
  return registry.get(query)?.get('change')?.size ?? 0
}

function activeListenerTypes(query: string): string[] {
  const byType = registry.get(query)
  if (byType === undefined) return []
  return [...byType.entries()].filter(([, set]) => set.size > 0).map(([type]) => type)
}

// Sets the viewport width and fires `change` only on the queries whose `matches` flipped.
function setWidth(next: number): void {
  const flipped = [...registry.keys()].filter(
    (query) => matchesAt(query, width) !== matchesAt(query, next),
  )
  width = next
  for (const query of flipped) {
    for (const listener of [...listenersOf(query, 'change')]) {
      listenerCalls += 1
      listener()
    }
  }
}

function fakeMatchMedia(query: string): MediaQueryList {
  minWidthPx(query)
  return {
    media: query,
    get matches() {
      return matchesAt(query, width)
    },
    addEventListener: (type: string, listener: Listener) => {
      listenersOf(query, type).add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listenersOf(query, type).delete(listener)
    },
    onchange: null,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
}

function newSpies(): Spies {
  return {
    mobile: vi.fn<() => void>(),
    tablet: vi.fn<() => void>(),
    desktop: vi.fn<() => void>(),
  }
}

// Three distinct components, one per branch; each records its own mount and unmount.
function makeBranches() {
  const mounts = newSpies()
  const unmounts = newSpies()
  const make = (name: BranchName) =>
    function Branch() {
      useEffect(() => {
        mounts[name]()
        return () => unmounts[name]()
      }, [])
      return createElement('p', { 'data-testid': name }, name)
    }
  return {
    mounts,
    unmounts,
    mobile: make('mobile'),
    tablet: make('tablet'),
    desktop: make('desktop'),
  }
}

beforeEach(() => {
  width = 375
  listenerCalls = 0
  registry.clear()
  vi.stubGlobal('matchMedia', fakeMatchMedia)
})

afterEach(() => {
  cleanup()
  registry.clear()
  vi.unstubAllGlobals()
})

describe('useDeviceClass', () => {
  it('uses rem breakpoints matching Tailwind v4 sm and lg', () => {
    expect(DEVICE_QUERIES).toEqual({ tablet: TABLET_QUERY, desktop: DESKTOP_QUERY })
  })

  it('maps widths to classes', () => {
    const cases: Array<[number, DeviceClass]> = [
      [375, 'mobile'],
      [639, 'mobile'],
      [640, 'tablet'],
      [1023, 'tablet'],
      [1024, 'desktop'],
    ]
    for (const [px, expected] of cases) {
      setWidth(px)
      expect(getDeviceClass()).toBe(expected)

      const { result, unmount } = renderHook(() => useDeviceClass())
      expect(result.current).toBe(expected)
      unmount()
    }
  })

  it('subscribes to the change event on both queries', () => {
    const { unmount } = renderHook(() => useDeviceClass())

    expect(changeListenerCount(TABLET_QUERY)).toBe(1)
    expect(changeListenerCount(DESKTOP_QUERY)).toBe(1)
    expect(activeListenerTypes(TABLET_QUERY)).toEqual(['change'])
    expect(activeListenerTypes(DESKTOP_QUERY)).toEqual(['change'])

    unmount()
  })

  it('re-renders on a media change', () => {
    const { result } = renderHook(() => useDeviceClass())
    expect(result.current).toBe('mobile')

    act(() => setWidth(800))
    expect(result.current).toBe('tablet')

    act(() => setWidth(1024))
    expect(result.current).toBe('desktop')

    act(() => setWidth(375))
    expect(result.current).toBe('mobile')
  })

  it('unsubscribes from both queries on unmount', () => {
    let renders = 0
    const { unmount } = renderHook(() => {
      renders += 1
      return useDeviceClass()
    })

    // sanity: while mounted, a flip reaches the store callback
    const callsWhileMounted = listenerCalls
    act(() => setWidth(800))
    expect(listenerCalls).toBeGreaterThan(callsWhileMounted)

    unmount()
    // asserted before cleanup, so afterEach cannot mask a leaked listener
    expect(changeListenerCount(TABLET_QUERY)).toBe(0)
    expect(changeListenerCount(DESKTOP_QUERY)).toBe(0)

    const callsAfterUnmount = listenerCalls
    const rendersAfterUnmount = renders
    setWidth(1024)
    expect(listenerCalls).toBe(callsAfterUnmount)
    expect(renders).toBe(rendersAfterUnmount)
  })

  it('ByDevice mounts only one branch', () => {
    const { mounts, unmounts, mobile, tablet, desktop } = makeBranches()

    render(
      createElement(ByDevice, {
        mobile: createElement(mobile),
        tablet: createElement(tablet),
        desktop: createElement(desktop),
      }),
    )
    expect(screen.getByTestId('mobile')).toBeTruthy()
    expect(mounts.mobile).toHaveBeenCalledTimes(1)
    expect(mounts.tablet).not.toHaveBeenCalled()
    expect(mounts.desktop).not.toHaveBeenCalled()

    act(() => setWidth(800))
    expect(screen.queryByTestId('mobile')).toBeNull()
    expect(screen.getByTestId('tablet')).toBeTruthy()
    expect(unmounts.mobile).toHaveBeenCalledTimes(1)
    expect(mounts.tablet).toHaveBeenCalledTimes(1)
    expect(mounts.desktop).not.toHaveBeenCalled()

    act(() => setWidth(1024))
    expect(screen.queryByTestId('tablet')).toBeNull()
    expect(screen.getByTestId('desktop')).toBeTruthy()
    expect(unmounts.tablet).toHaveBeenCalledTimes(1)
    expect(mounts.desktop).toHaveBeenCalledTimes(1)
    expect(mounts.mobile).toHaveBeenCalledTimes(1)
    expect(mounts.tablet).toHaveBeenCalledTimes(1)
  })

  it('falls back to desktop only when tablet is undefined or null', () => {
    const cases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
    ]
    for (const [label, tablet] of cases) {
      const { mounts, mobile, desktop } = makeBranches()
      setWidth(800)
      render(
        createElement(ByDevice, {
          mobile: createElement(mobile),
          tablet: tablet as null | undefined,
          desktop: createElement(desktop),
        }),
      )
      expect(screen.getByTestId('desktop'), label).toBeTruthy()
      expect(mounts.desktop, label).toHaveBeenCalledTimes(1)
      expect(mounts.mobile, label).not.toHaveBeenCalled()
      cleanup()
    }

    // An empty-string tablet node is a real tablet branch: it must NOT fall back to desktop.
    const { mounts, mobile, desktop } = makeBranches()
    setWidth(800)
    render(
      createElement(ByDevice, {
        mobile: createElement(mobile),
        tablet: '',
        desktop: createElement(desktop),
      }),
    )
    expect(mounts.desktop).not.toHaveBeenCalled()
    expect(mounts.mobile).not.toHaveBeenCalled()
  })

  it('same query key across classes', async () => {
    const fetcher = vi.fn(async () => 'data')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const makeProbe = (name: BranchName) =>
      function Probe() {
        useQuery({ queryKey: ['x'], queryFn: fetcher, staleTime: 30_000 })
        return createElement('p', { 'data-testid': name }, name)
      }

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ByDevice, {
          mobile: createElement(makeProbe('mobile')),
          tablet: createElement(makeProbe('tablet')),
          desktop: createElement(makeProbe('desktop')),
        }),
      ),
    )
    await waitFor(() => expect(queryClient.getQueryData(['x'])).toBe('data'))
    expect(screen.getByTestId('mobile')).toBeTruthy()

    act(() => setWidth(1024))

    expect(screen.queryByTestId('mobile')).toBeNull()
    expect(screen.getByTestId('desktop')).toBeTruthy()
    expect(queryClient.getQueryCache().findAll({ queryKey: ['x'] })).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('no window: getDeviceClass returns desktop', () => {
    vi.stubGlobal('window', undefined)

    expect(getDeviceClass()).toBe('desktop')
  })
})
