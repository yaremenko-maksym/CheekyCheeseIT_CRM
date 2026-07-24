/**
 * `client.tsx` calls `recordPrerenderedRoot()` exactly once, synchronously,
 * BEFORE `createRoot(rootEl).render()` — that call's first commit is what
 * clears any prerendered markup already inside `rootEl` (this is
 * `createRoot`, not `hydrateRoot` — see client.tsx's module doc), so it is
 * the ONLY point in the bundle's lifecycle where prerendered content is
 * still inspectable.
 *
 * Exists for `terminal.tsx`'s hero typewriter (found by ui-ux-designer
 * Mode B fidelity review, PR #398): `scripts/prerender.mjs` captures `/`
 * with the first code snippet already fully typed (its `preparePage()`
 * emulates `prefers-reduced-motion: reduce` for the capture), so a real
 * visitor's browser paints that complete snippet BEFORE any client JS
 * runs. Terminal's mount effect needs to know, on its very first mount,
 * whether to pick up from that already-typed state instead of resetting to
 * empty and re-animating characters the visitor already saw — but ONLY for
 * that first mount; a later SPA-navigation remount (home -> careers ->
 * home) has no prerendered DOM to preserve and must type normally, exactly
 * like before prerendering existed.
 */
let wasPrerendered = false

/** Called ONCE from client.tsx, before `createRoot(rootEl).render()`. */
export function recordPrerenderedRoot(rootEl: Element | null): void {
  wasPrerendered = (rootEl?.children.length ?? 0) > 0
}

/**
 * Read-only — callers combine this with their OWN "is this truly the first
 * mount" tracking (see terminal.tsx) rather than this module auto-resetting
 * itself, since it has exactly one consumer today and auto-reset semantics
 * would just hide that coupling.
 */
export function wasRootPrerendered(): boolean {
  return wasPrerendered
}
