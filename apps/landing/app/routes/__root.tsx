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
 * it (`RootDocument`'s `onBeforeNavigate` handler below never marks a
 * same-pathname hash change as focus-worthy, see its module doc).
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
 * about the transition motion itself. Still keyed off `onResolved` (not a
 * plain `useEffect` on `router.state.location.pathname`) — the actual
 * `focusMainLandmark()` call is deferred to a `useEffect` keyed on `navEpoch`
 * state, NOT called synchronously inside the `onResolved` subscriber —
 * `setState` there only SCHEDULES a re-render; calling `focusMainLandmark()`
 * right after it runs BEFORE React has committed that render, so
 * `document.querySelector('main')` at that instant can still find the OLD
 * page's `<main>` (or none at all) — this was a real, E2E-reproduced race in
 * the page-transition-era version of this file (`docs/design/
 * landing-redesign.md` §M v3 addendum has the original root-cause writeup);
 * the same two-step fix (subscribe to `onResolved`, defer the actual DOM call
 * to an effect) is kept here even though transition-direction is no longer
 * part of what's being tracked.
 *
 * fix/landing-focus-race (task-landing-e2e-in-ci.md's Part 2) — a
 * forward-then-IMMEDIATE-back round trip (A→B→A, e.g. a keyboard/AT user who
 * clicks a link then hits back right away, no human-speed pause) used to
 * silently swallow BOTH focus moves. Two real, independently-confirmed
 * causes (live-instrumented repro trace is in the PR), fixed together:
 *
 *   1. `onBeforeNavigate`'s own hash-only/same-route detection compared
 *      `toLocation.pathname` against `fromLocation.pathname`, where
 *      `fromLocation` is `@tanstack/react-router`'s `resolvedLocation`
 *      store — which the router only updates to match the new `location`
 *      INSIDE the `onResolved` `useLayoutEffect` (`Transitioner.tsx`), i.e.
 *      one React commit AFTER the navigation `fromLocation` is supposedly
 *      describing. A back-navigation started before that commit flushes
 *      sees a STALE `resolvedLocation` that can equal the new destination's
 *      pathname — a false positive that misclassifies a genuine cross-page
 *      back-navigation as a same-route hash change.
 *   2. Even once (1) is worked around, back-to-back navigations can get
 *      MERGED by the router itself: a new `load()` call cancels the
 *      previous one's in-flight matches (`beforeLoad()`'s `cancelMatches()`)
 *      before it ever individually settles, so `onResolved` (keyed off
 *      `isAnyPending` transitioning true→false) can fire only ONCE for the
 *      whole A→B→A round trip — reporting whatever `router.state.location`
 *      happens to be at that instant (the FINAL, back-navigated pathname).
 *      Comparing that single settled pathname against "where we started"
 *      nets to zero for a round trip that returns to the origin route, so
 *      ANY design that decides focus-worthiness from `onResolved`'s settled
 *      pathname alone — including comparing it to a self-owned ref instead
 *      of the library's `resolvedLocation` — reproduces the exact same
 *      false-negative, just via a different mechanism.
 *
 * Fix: decide focus-worthiness at `onBeforeNavigate` time instead (per
 * ATTEMPTED navigation, before any merging/cancellation can hide it), using
 * a pathname WE track ourselves (`currentPathnameRef`) rather than the
 * library's lagging `resolvedLocation` — updated eagerly, synchronously, on
 * every `onBeforeNavigate` call, regardless of whether that attempt ever
 * gets to resolve on its own. A sticky `shouldFocusRef` flag is set the
 * moment ANY attempt in a rapid sequence turns out to be cross-route, and is
 * only consumed (reset + effect triggered) whenever `onResolved` NEXT fires
 * — however many attempts got merged into that one settle. This correctly
 * handles all three cases:
 *   - Real cross-page nav: `toLocation.pathname` differs from the ref →
 *     flag set → next `onResolved` triggers the focus effect.
 *   - Hash-only nav on the SAME route (`smoothScrollToId`'s case, §M.4):
 *     pathname unchanged (hash isn't part of `pathname`) → flag untouched.
 *   - A→B→A immediate round trip: BOTH the forward and the back
 *     `onBeforeNavigate` calls see a real pathname change (against the
 *     ref, not each other) and set the flag — even if the router later
 *     merges their resolution into a single `onResolved`, that one firing
 *     still finds the flag set and correctly triggers a focus move to
 *     whatever `<main>` is ACTUALLY in the DOM once things settle.
 * `navEpoch` (state, a monotonically increasing counter rather than a
 * boolean) stays as the effect TRIGGER — cheap insurance against React
 * batching two `onResolved`-consuming updates into one commit (`prev + 1`
 * can never collapse back to a prior value the way comparing raw pathnames
 * in state could, see the earlier `resolvedPathname` version of this file).
 */
function RootDocument() {
  const router = useRouter()
  const isFirstRenderRef = useRef(true)
  // Our OWN tracking of "the pathname of the most recently ATTEMPTED
  // navigation" — updated eagerly inside `onBeforeNavigate`, never derived
  // from the router's own (lagging) `resolvedLocation` store. See module doc.
  const currentPathnameRef = useRef(router.state.location.pathname)
  // Sticky: true if ANY navigation attempt since the last `onResolved`
  // consumption turned out to be cross-route. Survives multiple
  // `onBeforeNavigate` calls landing before a single, possibly-merged
  // `onResolved` finally fires (the A→B→A case, see module doc).
  const shouldFocusRef = useRef(false)
  const [navEpoch, setNavEpoch] = useState(0)

  useEffect(() => {
    const unsubscribeBefore = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      if (toLocation.pathname !== currentPathnameRef.current) {
        shouldFocusRef.current = true
        currentPathnameRef.current = toLocation.pathname
      }
    })

    const unsubscribeResolved = router.subscribe('onResolved', () => {
      if (!shouldFocusRef.current) return
      shouldFocusRef.current = false
      setNavEpoch((prev) => prev + 1)
    })

    return () => {
      unsubscribeBefore()
      unsubscribeResolved()
    }
  }, [router])

  // Deferred to a real commit (see module doc) — skips the very first run
  // (initial mount, nothing navigated yet, browser owns focus as normal;
  // `navEpoch`'s initial value never came from a real navigation).
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    focusMainLandmark()
  }, [navEpoch])

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
