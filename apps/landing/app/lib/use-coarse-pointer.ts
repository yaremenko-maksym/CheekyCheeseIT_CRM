import { useEffect, useState } from 'react'

/**
 * Media-query-based touch/coarse-pointer detection (docs/design/landing-
 * redesign.md §M v3.3 п.2) — deliberately NOT user-agent sniffing, so it
 * reacts correctly to hybrid devices (e.g. a laptop with a touchscreen that
 * also has a trackpad) and to DevTools device emulation toggling mid-session
 * (the `change` listener below). Used to gate scroll-linked JS decor
 * (`ScrollReveal`, hero-glow/terminal-docking, connector-line, chip-wave,
 * case-study metric-lag) to a one-shot/static fallback on touch — the
 * continuous per-scroll-frame `useTransform` recalculation is the likely
 * "everything feels janky on iPhone" root cause the owner reported.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: none), (pointer: coarse)').matches,
  )
  useEffect(() => {
    const mql = window.matchMedia('(hover: none), (pointer: coarse)')
    const handler = () => setCoarse(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return coarse
}
