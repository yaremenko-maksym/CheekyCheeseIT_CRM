/**
 * Module-level singleton — which page-transition variant (§M.3) the NEXT
 * client-side navigation should use. Same pattern as `prerender-hint.ts`:
 * mutable global state living outside the React tree so it can be set
 * synchronously from a plain DOM event listener (`popstate`) or a
 * `<BackLink onClick>` handler, strictly BEFORE the router's
 * `onBeforeNavigate` subscriber (`__root.tsx`'s orchestrator) reads it once
 * per navigation and resets it back to the default (`'full'`) — a one-shot
 * override, never a mode switch.
 *
 * HOTFIX 2026-07-24: renamed `'wipe'` → `'full'` — the primary variant is no
 * longer a solid-fill "wipe", it's a dark scrim + thin caret-line sweep
 * (see `lib/scrim-transition.ts`); "full" describes what it now IS (the
 * full page-transition treatment), not a leftover visual metaphor.
 */
export type PageTransitionVariant = 'full' | 'light'

let pendingVariant: PageTransitionVariant = 'full'

/**
 * Browser back/forward (`window.addEventListener('popstate', ...)` in
 * `__root.tsx`) and `<BackLink>` clicks call this to force the lightweight
 * variant on the very next navigation (§M.3 steps 2-3).
 */
export function markNextTransitionLight(): void {
  pendingVariant = 'light'
}

/**
 * `__root.tsx`'s `onBeforeNavigate` subscriber calls this exactly once per
 * navigation that actually changes the route — reads the pending variant and
 * immediately resets it back to `'full'` so the override never leaks into a
 * later, unrelated navigation (§M.3 step 4).
 */
export function consumePendingVariant(): PageTransitionVariant {
  const variant = pendingVariant
  pendingVariant = 'full'
  return variant
}
