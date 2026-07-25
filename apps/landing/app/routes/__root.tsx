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

/** Resolves once the NEXT `onResolved` router event fires — one-shot, unsubscribes itself. */
function onceResolved(router: ReturnType<typeof useRouter>): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = router.subscribe('onResolved', () => {
      unsubscribe()
      resolve()
    })
  })
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
 */
function RootDocument() {
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement | null>(null)
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
    const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation, fromLocation }) => {
      // Hash-only change on the SAME route (e.g. nav "Contact" while already
      // on "/") — no page-transition; `smoothScrollToId` owns this case
      // exclusively (§M.4).
      if (fromLocation && toLocation.pathname === fromLocation.pathname) return

      // Cache the route pair for lib/title-morph.ts's consumer (§M v3.2
      // step 5) — avoids a second, independent router subscription there.
      if (fromLocation) setPendingRoutePair(fromLocation.pathname, toLocation.pathname)

      const direction = consumePendingDirection()
      playLiftExit(wrapperRef.current, isReducedMotionPreferred())
      setTransition({ pathname: toLocation.pathname, direction })

      // Focus management (WCAG 2.4.3, §M v3.1 step 7) — gated on the
      // router's OWN `onResolved` event, not on the enter-animation's
      // `onAnimationComplete`/this effect's `transition.pathname` state
      // change: BOTH of those fire at `onBeforeNavigate` time (immediately,
      // synchronously), which is BEFORE the destination route's async
      // loader resolves and `<Outlet/>` actually swaps in the real page
      // content — confirmed empirically via E2E (a race that reliably
      // reproduced under `prefers-reduced-motion`, where there's no
      // animation duration to accidentally paper over the gap): focusing
      // too early lands on a `<main>` that gets replaced moments later,
      // silently reverting `document.activeElement` to `<body>`. Waiting
      // for `onResolved` (same event/pattern the pre-v3 §M.3 orchestrator
      // used) guarantees the focused `<main>` is the FINAL, stable node.
      void onceResolved(router).then(focusMainLandmark)
    })
    return unsubscribe
  }, [router])

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
