import { useSyncExternalStore } from 'react'

const STANDALONE_QUERY = '(display-mode: standalone)'

// iOS Safari reports a home-screen launch only through navigator.standalone,
// not through the display-mode media query.
function isStandalone(): boolean {
  if (window.matchMedia(STANDALONE_QUERY).matches) return true
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

// navigator.standalone is fixed for the lifetime of the page, so it needs no change event.
function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(STANDALONE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useStandalone(): boolean {
  return useSyncExternalStore(subscribe, isStandalone, () => false)
}
