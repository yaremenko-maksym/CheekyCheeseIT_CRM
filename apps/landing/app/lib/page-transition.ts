/**
 * Module-level singleton — which direction (§M v3.1) the NEXT client-side
 * navigation's lift cross-fade should enter from. Same pattern as
 * `prerender-hint.ts`: mutable global state living outside the React tree so
 * it can be set synchronously from a plain DOM event listener (`popstate`)
 * or a `<BackLink onClick>` handler, strictly BEFORE the router's
 * `onBeforeNavigate` subscriber (`__root.tsx`'s orchestrator) reads it once
 * per navigation and resets it back to the default (`'forward'`) — a
 * one-shot override, never a mode switch.
 *
 * §M v3 (2026-07-25): renamed `pendingVariant: 'full'|'light'` (which effect
 * to play, §M.3, removed) → `pendingDirection: 'forward'|'back'` (which way
 * the SAME lift cross-fade enters from, §M v3.1) — the architecture (module
 * singleton, one-shot read-and-reset) is unchanged, only the semantics of
 * the value it carries.
 */
export type PageTransitionDirection = 'forward' | 'back'

let pendingDirection: PageTransitionDirection = 'forward'

/**
 * Browser back/forward (`window.addEventListener('popstate', ...)` in
 * `__root.tsx`) and `<BackLink>` clicks call this to force the `'back'`
 * lift-enter direction on the very next navigation (§M v3.1 steps 2-3).
 */
export function markNextTransitionBack(): void {
  pendingDirection = 'back'
}

/**
 * `__root.tsx`'s `onBeforeNavigate` subscriber calls this exactly once per
 * navigation that actually changes the route — reads the pending direction
 * and immediately resets it back to `'forward'` so the override never leaks
 * into a later, unrelated navigation (§M v3.1 step 5).
 */
export function consumePendingDirection(): PageTransitionDirection {
  const direction = pendingDirection
  pendingDirection = 'forward'
  return direction
}
