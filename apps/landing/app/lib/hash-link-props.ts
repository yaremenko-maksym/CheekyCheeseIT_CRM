import { smoothScrollToId } from './smooth-scroll'

/**
 * Shared by `nav.tsx` and `footer.tsx` (§M.4's 2-case table) — every in-page
 * anchor `<Link>` on the marketing surface needs the exact same conditional
 * wiring: on "/" itself, our own `smoothScrollToId` owns the scroll entirely
 * (native `hashScrollIntoView` disabled so the router doesn't ALSO jump
 * instantly first); navigating in from another route leaves the router's own
 * default (instant) hash-scroll-on-arrival untouched — the page swap itself
 * is instant (no page-transition, task-landing-remove-page-transitions.md),
 * and layering a smooth-scroll animation on top would be "annoying", not
 * "premium".
 *
 * design-review round 1 MED-1 — BOTH branches also need a keyboard/AT focus
 * move after landing (WCAG 2.4.3), not just the visual scroll:
 *   - same-page (`isHome`): the `onClick` here calls `smoothScrollToId`,
 *     which itself calls `lib/smooth-scroll.ts`'s `focusHashTarget` once the
 *     scroll settles.
 *   - cross-page: the router's native `hashScrollIntoView` positions the
 *     viewport; `routes/__root.tsx`'s `focusMainLandmark()` (already runs on
 *     every cross-page navigation for WCAG 2.4.3) now prefers the SAME hash
 *     target over the generic `<main>` landmark when the destination URL
 *     carries one.
 * Every hash id this function is ever called with (`services`/`work`/
 * `about`/`process`/`contact`) is a real `<section id="..." tabIndex={-1}>`
 * in `home-page-content.tsx` — the ONLY page any of these ids exist on.
 */
export function hashLinkProps(hash: string, isHome: boolean) {
  return {
    hash,
    hashScrollIntoView: !isHome,
    onClick: isHome ? () => smoothScrollToId(hash) : undefined,
  } as const
}
