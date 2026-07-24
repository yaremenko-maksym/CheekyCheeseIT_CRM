import { smoothScrollToId } from './smooth-scroll'

/**
 * Shared by `nav.tsx` and `footer.tsx` (§M.4's 2-case table) — every in-page
 * anchor `<Link>` on the marketing surface needs the exact same conditional
 * wiring: on "/" itself, our own `smoothScrollToId` owns the scroll entirely
 * (native `hashScrollIntoView` disabled so the router doesn't ALSO jump
 * instantly first); navigating in from another route leaves the router's own
 * default (instant) hash-scroll-on-arrival untouched — a full page-transition
 * plays instead (§M.3), and layering a second scroll animation on top would
 * be "annoying", not "premium".
 */
export function hashLinkProps(hash: string, isHome: boolean) {
  return {
    hash,
    hashScrollIntoView: !isHome,
    onClick: isHome ? () => smoothScrollToId(hash) : undefined,
  } as const
}
