import { useSyncExternalStore, type ReactNode } from 'react'

export type DeviceClass = 'mobile' | 'tablet' | 'desktop'

// Breakpoints in rem to match Tailwind v4 defaults (sm = 40rem, lg = 64rem); the project
// does not override --breakpoint-*, so JS layout switching agrees with `sm:` / `lg:` classes.
export const DEVICE_QUERIES: Record<Exclude<DeviceClass, 'mobile'>, string> = {
  tablet: '(min-width: 40rem)',
  desktop: '(min-width: 64rem)',
}

export function getDeviceClass(): DeviceClass {
  if (typeof window === 'undefined') return 'desktop'
  if (window.matchMedia(DEVICE_QUERIES.desktop).matches) return 'desktop'
  if (window.matchMedia(DEVICE_QUERIES.tablet).matches) return 'tablet'
  return 'mobile'
}

function subscribeDeviceClass(onChange: () => void): () => void {
  const queries = [DEVICE_QUERIES.tablet, DEVICE_QUERIES.desktop].map((query) =>
    window.matchMedia(query),
  )
  for (const mql of queries) mql.addEventListener('change', onChange)
  return () => {
    for (const mql of queries) mql.removeEventListener('change', onChange)
  }
}

export function useDeviceClass(): DeviceClass {
  return useSyncExternalStore(subscribeDeviceClass, getDeviceClass, getDeviceClass)
}

/**
 * Renders exactly one branch, so only one layout is mounted.
 *
 * Crossing a breakpoint (rotating a phone across 40rem) unmounts the other branch. State that
 * must survive lives above `ByDevice` (query cache, URL, store); stale queries refetch on
 * remount as usual.
 *
 * `tablet` falls back to `desktop` only when it is `undefined` or `null`.
 */
export function ByDevice(props: {
  mobile: ReactNode
  tablet?: ReactNode
  desktop: ReactNode
}): ReactNode {
  const device = useDeviceClass()
  if (device === 'mobile') return props.mobile
  if (device === 'tablet') return props.tablet ?? props.desktop
  return props.desktop
}
