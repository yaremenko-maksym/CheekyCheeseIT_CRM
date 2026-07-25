import { animate } from 'framer-motion'
import { DUR_TITLE_MORPH, EASE_SOFT } from './motion'

/**
 * Shared-element title morph, `/careers ↔ /careers/:slug` only (docs/design/
 * landing-redesign.md §M v3.2) — a "measure → invert → play" overlay-clone
 * (not a real single-node FLIP: the source `<h3>` and destination `<h1>` are
 * on physically different pages/DOM trees). Module-level singleton state,
 * same "mutable global outside the React tree" pattern as
 * `lib/page-transition.ts` — `captureMorphSource` runs synchronously from a
 * title's enclosing `<Link>`/`<BackLink>` `onClick`, `readPendingMorph` +
 * `validateMorphDestination` run from the destination page's
 * `useLayoutEffect` after the route has swapped.
 */
export interface PendingMorph {
  slug: string
  text: string
  rect: DOMRect
  fontSizePx: number
  lineHeightPx: number
}

interface RoutePair {
  from: string
  to: string
}

let pendingMorph: PendingMorph | null = null
let pendingRoutePair: RoutePair | null = null

function isCareersListPath(pathname: string): boolean {
  return pathname === '/careers' || pathname === '/careers/'
}

function isCareersDetailPath(pathname: string): boolean {
  return /^\/careers\/[^/]+\/?$/.test(pathname)
}

/**
 * The ONLY route pair the morph is allowed to play on (§M v3.2 "Область
 * действия"): `/careers → /careers/:slug` (forward, clicked from the list)
 * or `/careers/:slug → /careers` (back, `<BackLink>` "All roles"). Exported
 * for unit tests — every other pair (Home teaser → detail, detail → nav
 * logo home, ...) falls back to the base lift with zero special-casing.
 */
export function isMorphRoutePair(from: string, to: string): boolean {
  return (
    (isCareersListPath(from) && isCareersDetailPath(to)) ||
    (isCareersDetailPath(from) && isCareersListPath(to))
  )
}

/** `rect.height <= lineHeightPx * 1.3` — the "still a single line" guard used on both capture and consume (§M v3.2 п.3-5). */
function isSingleLine(heightPx: number, lineHeightPx: number): boolean {
  return heightPx <= lineHeightPx * 1.3
}

function resolveLineHeightPx(styles: CSSStyleDeclaration, fontSizePx: number): number {
  const parsed = parseFloat(styles.lineHeight)
  // `line-height: normal` (or anything non-numeric) resolves to `NaN` here —
  // fall back to the common ~1.5 browser default rather than treating it as
  // multi-line by accident.
  return Number.isFinite(parsed) ? parsed : fontSizePx * 1.5
}

/**
 * `__root.tsx`'s `onBeforeNavigate` orchestrator (§M v3.1 step 4) calls this
 * once per navigation, right next to its own `consumePendingDirection()` —
 * caches the route pair here instead of this module setting up a SECOND,
 * independent `router.subscribe('onBeforeNavigate', ...)` (§M v3.2 п.5).
 */
export function setPendingRoutePair(from: string, to: string): void {
  pendingRoutePair = { from, to }
}

/**
 * Capture step (§M v3.2 п.3/4) — called synchronously from the source
 * title's enclosing `<Link>`/`<BackLink>` `onClick`, before navigation
 * starts. Leaves `pendingMorph` unset (`null`) under reduced-motion or when
 * the source has already wrapped to 2+ lines — both cases fall back to the
 * base lift automatically, `readPendingMorph()` below just finds nothing.
 */
export function captureMorphSource(el: HTMLElement, slug: string): void {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    pendingMorph = null
    return
  }
  const rect = el.getBoundingClientRect()
  const styles = window.getComputedStyle(el)
  const fontSizePx = parseFloat(styles.fontSize)
  const lineHeightPx = resolveLineHeightPx(styles, fontSizePx)
  if (!isSingleLine(rect.height, lineHeightPx)) {
    pendingMorph = null
    return
  }
  pendingMorph = { slug, text: el.textContent ?? '', rect, fontSizePx, lineHeightPx }
}

/**
 * Consume step, route-pair half (§M v3.2 п.5, first 2 bullets) — reads (and
 * ALWAYS one-shot resets, regardless of outcome — п.5 "сразу сбросить") both
 * `pendingMorph` and the cached route pair. Returns `null` the instant
 * either is missing or the pair isn't the `/careers ↔ /careers/:slug` link;
 * callers still owe the remaining destination-side checks via
 * `validateMorphDestination` below before actually playing the morph.
 */
export function readPendingMorph(): PendingMorph | null {
  const morph = pendingMorph
  const routePair = pendingRoutePair
  pendingMorph = null
  pendingRoutePair = null
  if (!morph || !routePair) return null
  if (!isMorphRoutePair(routePair.from, routePair.to)) return null
  return morph
}

/**
 * Consume step, destination-side half (§M v3.2 п.5, last 3 bullets) — slug
 * match, destination single-line guard, staleness guard (captured text vs
 * the destination's actual current text). Pure / no mutation — safe to call
 * speculatively even when the caller ends up not playing the morph.
 */
export function validateMorphDestination(
  morph: PendingMorph,
  slug: string,
  destEl: HTMLElement,
): boolean {
  if (morph.slug !== slug) return false
  if (morph.text !== (destEl.textContent ?? '')) return false
  const destRect = destEl.getBoundingClientRect()
  const destStyles = window.getComputedStyle(destEl)
  const destFontSizePx = parseFloat(destStyles.fontSize)
  const destLineHeightPx = resolveLineHeightPx(destStyles, destFontSizePx)
  return isSingleLine(destRect.height, destLineHeightPx)
}

/**
 * Finds the `VacancyCard` title matching `slug` among just-mounted cards
 * (§M v3.2 п.5 — the `/careers` list-page consumer, back-direction landing).
 * Plain attribute-value scan rather than a `querySelector` template string —
 * sidesteps CSS.escape() availability/quoting concerns for slugs entirely.
 */
export function findMorphTargetElement(slug: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-vacancy-morph-slug]')
  for (const candidate of candidates) {
    if (candidate.dataset['vacancyMorphSlug'] === slug) return candidate
  }
  return null
}

/**
 * Plays the overlay-clone morph (§M v3.2 п.6-7) — measure → invert (the
 * clone appears INSTANTLY, no animation, at the exact source position/size)
 * → play (imperative `animate()` to the destination position/size, scaled
 * by font-size ratio, never by animating `font-size` itself — layout-
 * triggering, breaks the hard transform/opacity-only constraint). Hides the
 * real destination title for the duration (`visibility: hidden`, NOT
 * `display: none` — stays in the layout flow so `destEl.getBoundingClientRect()`
 * below still returns its real position/size) and restores it once the
 * clone lands pixel-for-pixel on top of it.
 */
export function playTitleMorphOverlay(morph: PendingMorph, destEl: HTMLElement): void {
  destEl.style.visibility = 'hidden'
  const destRect = destEl.getBoundingClientRect()
  const destFontSizePx = parseFloat(window.getComputedStyle(destEl).fontSize)
  const scaleFactor = destFontSizePx / morph.fontSizePx

  const overlay = document.createElement('div')
  overlay.setAttribute('aria-hidden', 'true')
  overlay.textContent = morph.text
  overlay.style.position = 'fixed'
  overlay.style.top = '0'
  overlay.style.left = '0'
  overlay.style.margin = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = '1000'
  overlay.style.whiteSpace = 'nowrap'
  overlay.style.fontWeight = '600'
  overlay.style.color = 'var(--foreground)'
  overlay.style.transformOrigin = 'top left'
  overlay.style.fontSize = `${morph.fontSizePx}px`
  overlay.style.willChange = 'transform'
  const startTransform = `translate(${morph.rect.left}px, ${morph.rect.top}px) scale(1)`
  const endTransform = `translate(${destRect.left}px, ${destRect.top}px) scale(${scaleFactor})`
  overlay.style.transform = startTransform
  document.body.appendChild(overlay)

  const cleanup = () => {
    overlay.remove()
    destEl.style.visibility = ''
  }
  void animate(
    overlay,
    { transform: [startTransform, endTransform] },
    { duration: DUR_TITLE_MORPH, ease: EASE_SOFT },
  ).then(cleanup, cleanup)
}
