import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { animate, motion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { useDocumentHead } from '@/lib/use-document-head'
import { canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { PageTransitionOverlay } from '@/components/marketing/page-transition-overlay'
import { BackLink } from '@/components/marketing/back-link'
import { consumePendingVariant, markNextTransitionLight } from '@/lib/page-transition'
import {
  DUR_LIGHT_TRANSITION,
  DUR_WIPE_IN,
  DUR_WIPE_OUT,
  EASE_EXIT,
  EASE_STANDARD,
} from '@/lib/motion'
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
 * Moves focus to the new page's `<main>` landmark (WCAG 2.4.3 — §M.3 step 9).
 * Every route wraps its content in `<main tabIndex={-1}>` specifically so
 * this works: the SPA never reloads the document, so without an explicit
 * focus move keyboard/AT users get no signal the page changed at all.
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
 * redesign.md §M.3). Two variants:
 *
 * - `'wipe'` (default/primary) — the full-screen yellow bar (`overlayRef`)
 *   sweeps in, the route swaps INSTANTLY underneath it (invisible), the bar
 *   sweeps back out.
 * - `'light'` (browser back/forward, `<BackLink>`) — no bar; the content
 *   wrapper below fades/slides in on a plain `key`-based remount instead.
 *
 * Hash-only navigations (same pathname) are explicitly skipped — that case
 * belongs entirely to `smoothScrollToId` (§M.4), not this orchestrator.
 */
function RootDocument() {
  const router = useRouter()
  const overlayRef = useRef<HTMLDivElement>(null)
  const [transition, setTransition] = useState<{
    pathname: string
    variant: 'wipe' | 'light' | null
  }>({ pathname: router.state.location.pathname, variant: null })

  // Browser back/forward always uses the lightweight variant (§M.3 step 2) —
  // registered once, independent of the onBeforeNavigate subscription below.
  useEffect(() => {
    const onPopState = () => markNextTransitionLight()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation, fromLocation }) => {
      // Hash-only change on the SAME route (e.g. nav "Contact" while already
      // on "/") — no page-transition; `smoothScrollToId` owns this case
      // exclusively (§M.3 step 4 / §M.4).
      if (fromLocation && toLocation.pathname === fromLocation.pathname) return

      const variant = consumePendingVariant()
      const reduced = isReducedMotionPreferred()

      if (reduced) {
        // Full stop — no bar, no content-wrapper animation, router does its
        // normal instant SPA swap. Focus still moves once resolved.
        setTransition({ pathname: toLocation.pathname, variant: null })
        void onceResolved(router).then(focusMainLandmark)
        return
      }

      setTransition({ pathname: toLocation.pathname, variant })

      if (variant === 'light') {
        // The content wrapper (rendered below) plays the fade/slide on its
        // own via the `key` remount — focus moves as soon as the navigation
        // resolves (step 9, "оба варианта").
        void onceResolved(router).then(focusMainLandmark)
        return
      }

      // Primary "wipe": bar sweeps in, hold until BOTH the sweep-in
      // animation AND the router's own onResolved have fired (whichever is
      // later — thanks to `defaultPreload: 'intent'` this is almost always
      // the animation, see §M.3 step 7), move focus (still hidden under the
      // opaque bar), then sweep back out and reset off-screen.
      const overlay = overlayRef.current
      if (!overlay) return
      void (async () => {
        const wipeIn = animate(
          overlay,
          { x: ['-100%', '0%'] },
          { duration: DUR_WIPE_IN, ease: EASE_STANDARD },
        )
        await Promise.all([wipeIn, onceResolved(router)])
        focusMainLandmark()
        await animate(
          overlay,
          { x: ['0%', '100%'] },
          { duration: DUR_WIPE_OUT, ease: EASE_STANDARD },
        )
        animate(overlay, { x: '-100%' }, { duration: 0 })
      })()
    })
    return unsubscribe
  }, [router])

  return (
    <>
      <PageTransitionOverlay ref={overlayRef} />
      {transition.variant === 'light' ? (
        <motion.div
          key={transition.pathname}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: DUR_LIGHT_TRANSITION, ease: EASE_EXIT }}
        >
          <Outlet />
        </motion.div>
      ) : (
        <Outlet />
      )}
    </>
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
