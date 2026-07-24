import { animate, type AnimationPlaybackControls } from 'framer-motion'
import { DUR_CARET_SWEEP, DUR_SCRIM_IN, DUR_SCRIM_OUT, EASE_SOFT } from './motion'

/**
 * The two layers `<PageTransitionOverlay>` renders (docs/design/landing-
 * redesign.md §M.3/§M.3.0 HOTFIX) — a full-viewport dark scrim
 * (`var(--background)`, opacity-animated) and a thin `~64px` gradient
 * caret-line that sweeps across the screen once, on top of the already-
 * darkened scrim. Replaces the removed full-screen `bg-primary` "wipe"
 * fill — see §M.3.0's WCAG 2.3.1 luminance calculation for why.
 */
export interface ScrimTransitionElements {
  scrim: HTMLElement
  caret: HTMLElement
}

/**
 * Module-level singleton — there is exactly ONE page-transition overlay
 * (scrim + caret pair) in the whole app (`__root.tsx`'s
 * `<PageTransitionOverlay>`), so a single shared "what's currently
 * animating" handle is enough (same pattern as `page-transition.ts`/
 * `prerender-hint.ts`: mutable state outside the React tree, not a class
 * instance).
 */
let activeAnimations: AnimationPlaybackControls[] = []

/**
 * Bumped on every cancel/new-run — lets an in-flight `runScrimTransition()`
 * continuation detect it has been superseded (via `generation !==
 * myGeneration`) even after its awaited promise eventually settles (which it
 * always does one way or another: `.stop()` rejects it, or the router's
 * `onResolved` for a LATER navigation still fulfills an abandoned `waitFor`).
 */
let generation = 0

/**
 * Immediately halts any in-flight scrim/caret animation and resets BOTH
 * layers to their idle state (scrim fully transparent, caret parked
 * off-screen to the left) — used both by a superseding
 * `runScrimTransition()` call and directly by `__root.tsx`'s orchestrator on
 * EVERY navigation (including ones that end up using the `light`/reduced-
 * motion path), so a rapid double-click can never leave either layer stuck
 * mid-animation no matter which variant the SECOND navigation resolves to.
 *
 * `.stop()` (not `.cancel()`) — commits the current mid-animation value
 * instead of reverting to the animation's own start value; either way we
 * immediately follow up with an explicit instant reset, so the distinction
 * only matters for one intermediate (never-painted) frame.
 */
export function cancelScrimTransition(elements: ScrimTransitionElements): void {
  generation++
  activeAnimations.forEach((controls) => controls.stop())
  activeAnimations = []
  animate(elements.scrim, { opacity: 0 }, { duration: 0 })
  animate(elements.caret, { x: '-15vw' }, { duration: 0 })
}

/**
 * Runs the full scrim + caret-line sequence (§M.3): fade the scrim in while
 * the caret sweeps across (parallel, caret runs longer — "неспешный
 * свайп"), wait for `waitFor` to resolve, call `onMidSweep` (safe point —
 * the screen is darkened, e.g. to move focus), fade the scrim back out,
 * reset both layers off-screen/transparent.
 *
 * Always supersedes/cancels any run already in flight FIRST — without this,
 * a second `onBeforeNavigate` firing before the first sweep finishes (rapid
 * double-click, or clicking a second link mid-transition) would start
 * SECOND `animate()` calls racing the first on the same overlay DOM nodes,
 * and whichever one's async continuation settles last would win the final
 * "reset" step unpredictably.
 */
export async function runScrimTransition(
  elements: ScrimTransitionElements,
  waitFor: Promise<void>,
  onMidSweep: () => void,
): Promise<void> {
  cancelScrimTransition(elements)
  const myGeneration = generation

  const noop = () => undefined
  // Parallel, NOT gated together below — the caret is intentionally LONGER
  // (DUR_CARET_SWEEP=420ms) than the scrim-in phase (DUR_SCRIM_IN=230ms) so
  // it keeps sweeping into the hold/scrim-out phase, reading as one
  // continuous "неспешный" (unhurried) motion rather than two animations
  // racing to finish together (§M.3 step 5). Both are tracked in
  // `activeAnimations` purely so a superseding run can `.stop()` either one
  // mid-flight.
  const scrimIn = animate(
    elements.scrim,
    { opacity: [0, 0.94] },
    { duration: DUR_SCRIM_IN, ease: EASE_SOFT },
  )
  const caretSweep = animate(
    elements.caret,
    { x: ['-15vw', '105vw'] },
    { duration: DUR_CARET_SWEEP, ease: EASE_SOFT },
  )
  activeAnimations = [scrimIn, caretSweep]

  // `.then(noop, noop)` — a `.stop()`-interrupted animation rejects its
  // promise; swallow that here so a superseded run's own `Promise.all`
  // below still settles (instead of an unhandled rejection) and falls
  // through to the generation check, which is the ONE thing that decides
  // whether this run still owns the overlay. `caretSweep` is deliberately
  // NOT part of the `Promise.all` gate (see comment above — it's allowed to
  // keep running past scrim-in), but it still needs its OWN rejection
  // handler attached here (fire-and-forget) — otherwise a `.stop()` on it
  // (from a superseding cancel) rejects a promise nothing is listening to,
  // which Node/the browser reports as an unhandled rejection.
  void caretSweep.then(noop, noop)
  await Promise.all([scrimIn.then(noop, noop), waitFor])
  if (generation !== myGeneration) return // superseded mid scrim-in/caret-sweep

  onMidSweep()

  const scrimOut = animate(
    elements.scrim,
    { opacity: [0.94, 0] },
    { duration: DUR_SCRIM_OUT, ease: EASE_SOFT },
  )
  activeAnimations = [scrimOut]
  await scrimOut.then(noop, noop)
  if (generation !== myGeneration) return // superseded mid scrim-out

  activeAnimations = []
  // Same scrim-then-caret order as `cancelScrimTransition` above — kept
  // consistent so nothing depends on a specific reset ordering.
  animate(elements.scrim, { opacity: 0 }, { duration: 0 })
  animate(elements.caret, { x: '-15vw' }, { duration: 0 })
}
