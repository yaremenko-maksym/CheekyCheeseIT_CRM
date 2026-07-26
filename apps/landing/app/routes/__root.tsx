import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { LazyMotion, domMin } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { useDocumentHead } from '@/lib/use-document-head'
import { canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { BackLink } from '@/components/marketing/back-link'
import { cn, focusRing } from '@/lib/utils'
import { focusHashTarget } from '@/lib/smooth-scroll'
import { en } from '@/i18n/dictionaries/en'
import '../styles/globals.css'

export const Route = createRootRoute({
  component: RootDocument,
  notFoundComponent: NotFoundPage,
})

/**
 * Moves focus to the new page's `<main>` landmark (WCAG 2.4.3). Every route
 * wraps its content in `<main tabIndex={-1}>` specifically so this works:
 * the SPA never reloads the document, so without an explicit focus move
 * keyboard/AT users get no signal the page changed at all.
 *
 * design-review round 1 MED-1 — a CROSS-page navigation whose destination
 * URL carries a hash (e.g. footer/nav "Start a project" clicked from
 * `/careers`, landing on `/#contact`) prefers that hash target over the
 * generic `<main>` landmark: the router's own native `hashScrollIntoView`
 * (`hash-link-props.ts`) already positions the viewport there, so focus
 * should follow the SAME target, not the top of the page. Falls back to
 * `<main>` exactly as before when there is no hash, or the hash doesn't
 * resolve to an element — every existing pinned behaviour (motion-v3.spec.ts)
 * only ever exercises hash-LESS cross-page navigations, so this is additive,
 * not a change to any previously-tested path. The SAME-page case (already on
 * `/`, clicking a hash link) is `smoothScrollToId`'s own concern (via the
 * SAME `focusHashTarget` helper) — this function is never even reached for
 * it (`shouldFocusOnResolveRef` below is `false` for a same-pathname hash
 * change, see the module doc).
 */
function focusMainLandmark(): void {
  const hash = window.location.hash.slice(1)
  if (hash && focusHashTarget(hash)) return
  const main = document.querySelector('main')
  if (main instanceof HTMLElement) {
    main.focus({ preventScroll: true })
  }
}

/**
 * Root layout — task-landing-remove-page-transitions.md (owner decision
 * 2026-07-26): the page-transition layer that used to live here (§M v3.1
 * "soft lift" cross-fade + §M v3.2 shared-element title morph, docs/design/
 * landing-redesign.md, now marked SUPERSEDED) is REMOVED entirely — owner:
 * "получились криво, очень быстро мигает — уберём совсем, будем просто
 * ререндерить страницу без перехода". `<Outlet/>` renders directly, no
 * `key`-remounted wrapper, no enter/exit animation of any kind.
 *
 * `LazyMotion`/`domMin` stays — unrelated bundle-composition perf
 * optimization for every OTHER `m.*` site in the app (`ScrollReveal`,
 * `nav.tsx`, `case-study-card.tsx`, `terminal.tsx`, ... — see each one's own
 * comment), which still needs a `LazyMotion` ancestor even with zero
 * page-transition motion left in THIS file.
 *
 * What's left, and MUST keep working (task AC3) — focus-management only
 * (WCAG 2.4.3), the one piece of the old orchestrator that wasn't actually
 * about the transition motion itself. Still keyed off
 * `onBeforeNavigate`/`onResolved` (not a plain `useEffect` on
 * `router.state.location.pathname`): the hash-only guard below is
 * load-bearing — a same-pathname hash navigation (nav "Contact" while
 * already on `/`) is `smoothScrollToId`'s case exclusively (§M.4 in the
 * design doc) and must NOT steal focus for what is purely an in-page
 * scroll (`onResolved` still fires for it, `onBeforeNavigate` is the only
 * point that reliably distinguishes it). The actual `focusMainLandmark()`
 * call is deferred to a `useEffect` keyed on `resolvedPathname` state, NOT
 * called synchronously inside the `onResolved` subscriber — `setState`
 * there only SCHEDULES a re-render; calling `focusMainLandmark()` right
 * after it runs BEFORE React has committed that render, so
 * `document.querySelector('main')` at that instant can still find the OLD
 * page's `<main>` (or none at all) — this was a real, E2E-reproduced race
 * in the page-transition-era version of this file (`docs/design/
 * landing-redesign.md` §M v3 addendum has the original root-cause writeup);
 * the same two-step fix (subscribe to `onResolved`, defer the actual DOM
 * call to an effect) is kept here even though transition-direction is no
 * longer part of what's being tracked.
 */
function RootDocument() {
  const router = useRouter()
  const shouldFocusOnResolveRef = useRef(false)
  const isFirstRenderRef = useRef(true)
  const [resolvedPathname, setResolvedPathname] = useState(router.state.location.pathname)

  useEffect(() => {
    const unsubscribeBefore = router.subscribe(
      'onBeforeNavigate',
      ({ toLocation, fromLocation }) => {
        // Hash-only change on the SAME route — see module doc.
        shouldFocusOnResolveRef.current = !(
          fromLocation && toLocation.pathname === fromLocation.pathname
        )
      },
    )

    const unsubscribeResolved = router.subscribe('onResolved', () => {
      if (!shouldFocusOnResolveRef.current) return
      shouldFocusOnResolveRef.current = false
      const pathname = router.state.location.pathname
      // Guard against a no-op update in case `onResolved` ever fires more
      // than once for the same commit.
      setResolvedPathname((prev) => (prev === pathname ? prev : pathname))
    })

    return () => {
      unsubscribeBefore()
      unsubscribeResolved()
    }
  }, [router])

  // Deferred to a real commit (see module doc) — skips the very first run
  // (initial mount, nothing navigated yet, browser owns focus as normal;
  // `resolvedPathname`'s initial value never came from a real navigation).
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    focusMainLandmark()
  }, [resolvedPathname])

  return (
    <LazyMotion features={domMin}>
      <Outlet />
    </LazyMotion>
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
      <MarketingNav dict={en} />
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
      <MarketingFooter dict={en} />
    </div>
  )
}
