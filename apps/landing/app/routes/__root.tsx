import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { useDocumentHead } from '@/lib/use-document-head'
import { canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { BackLink } from '@/components/marketing/back-link'
import {
  consumePendingDirection,
  markNextTransitionBack,
  type PageTransitionDirection,
} from '@/lib/page-transition'
import { playLiftExit } from '@/lib/lift-transition'
import { setPendingRoutePair } from '@/lib/title-morph'
import { DUR_LIFT_ENTER, EASE_SOFT, LIFT_OFFSET_ENTER } from '@/lib/motion'
import { cn, focusRing } from '@/lib/utils'
import '../styles/globals.css'

export const Route = createRootRoute({
  component: RootDocument,
  notFoundComponent: NotFoundPage,
})

function isReducedMotionPreferred(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Moves focus to the new page's `<main>` landmark (WCAG 2.4.3 — §M v3.1
 * step 7). Every route wraps its content in `<main tabIndex={-1}>`
 * specifically so this works: the SPA never reloads the document, so
 * without an explicit focus move keyboard/AT users get no signal the page
 * changed at all.
 */
function focusMainLandmark(): void {
  const main = document.querySelector('main')
  if (main instanceof HTMLElement) {
    main.focus({ preventScroll: true })
  }
}

/**
 * Page-transition + in-page smooth-scroll orchestrator (docs/design/landing-
 * redesign.md §M v3.1) — a "soft lift" cross-fade on EVERY navigation, via
 * ONE shared, key-remounted content wrapper (no `AnimatePresence`, no
 * scrim/overlay — §M.3 removed entirely, see §M v3 "SUPERSEDED"). The exit
 * half plays imperatively (fire-and-forget, `playLiftExit`) on the
 * still-mounted OLD wrapper right before the route swaps; the enter half is
 * the new wrapper's own mount animation, direction-aware
 * (`pendingDirection` — forward from the bottom, back from the top).
 *
 * Hash-only navigations (same pathname) are explicitly skipped — that case
 * belongs entirely to `smoothScrollToId` (§M.4), not this orchestrator.
 *
 * **`key` timing — fixed 2026-07-25 (HIGH fidelity-review finding).** The
 * wrapper's `key`/`transition.pathname` state is updated ONLY from the
 * router's `onResolved` event (the router has ACTUALLY committed the new
 * match, `<Outlet/>` is ready to render it) — NEVER from `onBeforeNavigate`'s
 * optimistic `toLocation.pathname`. Root cause of the bug this fixes: React
 * `key`-remount is synchronous and immediate, but `onBeforeNavigate` fires
 * BEFORE the router internally switches `router.state.matches` — so setting
 * `key` there force-unmounts+remounts the wrapper while `<Outlet/>` is
 * STILL rendering the OLD route (its async loader/match hasn't committed
 * yet), producing a spurious extra mount of the OLD page's component. That
 * spurious remount's own `useLayoutEffect` (the title-morph consumer on
 * `careers-list.tsx`/`careers_.$slug.tsx`) fired FIRST and silently
 * consumed the one-shot `pendingMorph` meant for the REAL destination page,
 * which then mounted moments later to nothing — the shared-element title
 * morph (§M v3.2) never played, in EITHER direction, though the base lift
 * (§M v3.1) still looked correct (masking the bug from casual visual QA).
 * `lib/title-morph.ts`'s `readPendingMorph` also gained an independent,
 * addressable "is this consumer actually the destination" check as a second
 * defense layer — see its doc for why both fixes matter together.
 */
function RootDocument() {
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const pendingDirectionRef = useRef<PageTransitionDirection>('forward')
  const shouldTransitionOnResolveRef = useRef(false)
  const [transition, setTransition] = useState<{
    pathname: string
    direction: PageTransitionDirection | null
  }>({ pathname: router.state.location.pathname, direction: null })

  // Browser back/forward always uses the "back" enter direction (§M v3.1
  // step 2) — registered once, independent of the onBeforeNavigate
  // subscription below.
  useEffect(() => {
    const onPopState = () => markNextTransitionBack()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const unsubscribeBefore = router.subscribe(
      'onBeforeNavigate',
      ({ toLocation, fromLocation }) => {
        // Hash-only change on the SAME route (e.g. nav "Contact" while
        // already on "/") — no page-transition; `smoothScrollToId` owns
        // this case exclusively (§M.4). Explicitly tell the `onResolved`
        // handler below to skip its work too (it still fires for hash-only
        // navigations) — must NOT flip the wrapper key or steal focus for
        // what is purely an in-page scroll.
        if (fromLocation && toLocation.pathname === fromLocation.pathname) {
          shouldTransitionOnResolveRef.current = false
          return
        }

        // Cache the route pair for lib/title-morph.ts's consumer (§M v3.2
        // step 5) — avoids a second, independent router subscription there.
        if (fromLocation) setPendingRoutePair(fromLocation.pathname, toLocation.pathname)

        // Direction must be consumed HERE (one-shot, `onBeforeNavigate` is
        // the only point that reliably fires once per real navigation) —
        // stashed in a ref since the wrapper-key update itself is deferred
        // to `onResolved` below (see this function's module doc).
        pendingDirectionRef.current = consumePendingDirection()
        playLiftExit(wrapperRef.current, isReducedMotionPreferred())
        shouldTransitionOnResolveRef.current = true
      },
    )

    const unsubscribeResolved = router.subscribe('onResolved', () => {
      if (!shouldTransitionOnResolveRef.current) return
      shouldTransitionOnResolveRef.current = false
      const pathname = router.state.location.pathname
      // The router HAS committed by this point — `<Outlet/>` is already
      // ready to render the real destination the instant the wrapper below
      // remounts under the new `key`. Guard against a no-op update (in case
      // `onResolved` ever fires more than once for the same commit).
      setTransition((prev) =>
        prev.pathname === pathname ? prev : { pathname, direction: pendingDirectionRef.current },
      )
    })

    return () => {
      unsubscribeBefore()
      unsubscribeResolved()
    }
  }, [router])

  // Focus management (WCAG 2.4.3, §M v3.1 step 7) — a `useEffect` keyed on
  // `transition.pathname`, NOT a call inlined into the `onResolved`
  // subscriber above. `setTransition` merely SCHEDULES a re-render; calling
  // `focusMainLandmark()` synchronously right after it (as an earlier
  // version of this fix did) runs BEFORE React has committed that render —
  // `document.querySelector('main')` at that instant can still find the
  // OLD page's `<main>` (or none at all), reliably reproduced via E2E
  // (`document.activeElement` stayed `BODY`/reverted to a stray link, never
  // landed on `MAIN`). `useEffect` fires strictly AFTER the DOM commit for
  // the render that set this exact `transition.pathname`, so the `<main>`
  // it finds is guaranteed to be the real, final, already-painted one.
  useEffect(() => {
    if (transition.direction !== null) focusMainLandmark()
  }, [transition.pathname])

  const reducedMotion = isReducedMotionPreferred()

  return (
    <motion.div
      key={transition.pathname}
      ref={wrapperRef}
      initial={
        reducedMotion || transition.direction === null
          ? false
          : {
              opacity: 0,
              y: transition.direction === 'back' ? -LIFT_OFFSET_ENTER : LIFT_OFFSET_ENTER,
            }
      }
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR_LIFT_ENTER, ease: EASE_SOFT }}
    >
      <Outlet />
    </motion.div>
  )
}

/**
 * Site-wide 404 (task-landing-seo-prerender.md §1 AC2 — "404.html корректен").
 * Renders for any path that matches no route (TanStack Router's default
 * `notFoundComponent` slot). Also captured verbatim as the static
 * `dist/404.html` by `scripts/prerender.mjs` for static-host/CDN fallback —
 * distinct from `careers_.$slug.tsx`'s `NotFoundState`, which is specifically
 * an expired/unknown *vacancy slug*, not a site-wide unknown path.
 */
function NotFoundPage() {
  useDocumentHead({
    title: 'Page not found — CheekyCheeseIT',
    description: "The page you're looking for doesn't exist or has moved.",
    canonical: canonicalUrl('/404'),
    noindex: true,
  })
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav />
      <main
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-5 py-24 text-center focus:outline-none"
      >
        <div>
          <h1 className="mb-3 text-[1.6rem] font-semibold tracking-[-0.015em] text-foreground">
            Page not found
          </h1>
          <p className="mb-6 text-muted-foreground">
            The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
          </p>
          <BackLink
            to="/"
            className={cn('inline-flex items-center gap-2 font-medium text-primary', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back home
          </BackLink>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
