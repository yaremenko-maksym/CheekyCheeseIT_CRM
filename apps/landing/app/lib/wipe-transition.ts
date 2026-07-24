import { animate, type AnimationPlaybackControls } from 'framer-motion'
import { DUR_WIPE_IN, DUR_WIPE_OUT, EASE_STANDARD } from './motion'

/**
 * Module-level singleton — there is exactly ONE page-transition overlay node
 * in the whole app (`__root.tsx`'s `<PageTransitionOverlay>`), so a single
 * shared "what's currently animating it" handle is enough (same pattern as
 * `page-transition.ts`/`prerender-hint.ts`: mutable state outside the React
 * tree, not a class instance).
 */
let activeAnimation: AnimationPlaybackControls | null = null

/**
 * Bumped on every cancel/new-run — lets an in-flight `runWipeTransition()`
 * continuation detect it has been superseded (via `generation !==
 * myGeneration`) even after its awaited promise eventually settles (which it
 * always does one way or another: `.stop()` rejects it, or the router's
 * `onResolved` for a LATER navigation still fulfills an abandoned `waitFor`).
 */
let generation = 0

/**
 * Immediately halts any in-flight wipe-sweep step and snaps the overlay back
 * fully off-screen (§M.3) — used both by a superseding `runWipeTransition()`
 * call and directly by `__root.tsx`'s orchestrator on EVERY navigation
 * (including ones that end up using the `light`/reduced-motion path), so a
 * rapid double-click can never leave the overlay stuck mid-sweep no matter
 * which variant the SECOND navigation resolves to.
 *
 * `.stop()` (not `.cancel()`) — commits the current mid-animation value
 * instead of reverting to the animation's own start value; either way we
 * immediately follow up with an explicit instant reset, so the distinction
 * only matters for one intermediate (never-painted) frame.
 */
export function cancelWipeTransition(overlay: HTMLElement): void {
  generation++
  activeAnimation?.stop()
  activeAnimation = null
  animate(overlay, { x: '-100%' }, { duration: 0 })
}

/**
 * Runs the full "yellow caret" wipe sequence (§M.3): sweep the overlay fully
 * across the screen, wait for `waitFor` to resolve, call `onMidSweep` (safe
 * point — the screen is fully covered, e.g. to move focus), sweep back out,
 * reset off-screen.
 *
 * Always supersedes/cancels any run already in flight FIRST — without this,
 * a second `onBeforeNavigate` firing before the first sweep finishes (rapid
 * double-click, or clicking a second link mid-transition) would start a
 * SECOND `animate()` call racing the first on the same overlay DOM node,
 * and whichever one's async continuation settles last would win the final
 * "reset off-screen" step unpredictably.
 */
export async function runWipeTransition(
  overlay: HTMLElement,
  waitFor: Promise<void>,
  onMidSweep: () => void,
): Promise<void> {
  cancelWipeTransition(overlay)
  const myGeneration = generation

  const noop = () => undefined
  const wipeIn = animate(
    overlay,
    { x: ['-100%', '0%'] },
    { duration: DUR_WIPE_IN, ease: EASE_STANDARD },
  )
  activeAnimation = wipeIn
  // `.then(noop, noop)` — a `.stop()`-interrupted animation rejects its
  // promise; swallow that here so a superseded run's own `Promise.all`
  // below still settles (instead of an unhandled rejection) and falls
  // through to the generation check, which is the ONE thing that decides
  // whether this run still owns the overlay.
  await Promise.all([wipeIn.then(noop, noop), waitFor])
  if (generation !== myGeneration) return // superseded mid sweep-in

  onMidSweep()

  const wipeOut = animate(
    overlay,
    { x: ['0%', '100%'] },
    { duration: DUR_WIPE_OUT, ease: EASE_STANDARD },
  )
  activeAnimation = wipeOut
  await wipeOut.then(noop, noop)
  if (generation !== myGeneration) return // superseded mid sweep-out

  activeAnimation = null
  animate(overlay, { x: '-100%' }, { duration: 0 })
}
