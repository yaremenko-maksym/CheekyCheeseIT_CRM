import { useSyncExternalStore, type ReactNode } from 'react'

export type DeviceClass = 'mobile' | 'tablet' | 'desktop'

// Breakpoints in CSS px, matching the device classes in responsive-design.md.
export const DEVICE_QUERIES: Record<Exclude<DeviceClass, 'mobile'>, string> = {
  tablet: '(min-width: 640px)',
  desktop: '(min-width: 1024px)',
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

// Renders exactly one branch, so only one layout is mounted; tablet falls back to desktop.
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
