import { Link } from '@tanstack/react-router'
import type { ComponentPropsWithoutRef } from 'react'

type BackLinkProps = ComponentPropsWithoutRef<typeof Link>

/**
 * Drop-in replacement for `<Link>` at every semantically "back" navigation
 * (`careers_.$slug.tsx`'s "All roles" / "Back to careers", `__root.tsx`'s 404
 * "Back home"). Plain `<Link>` today — task-landing-remove-page-
 * transitions.md removed the page-transition direction it used to mark on
 * click (§M v3.1's lift-enter direction, docs/design/landing-redesign.md,
 * now SUPERSEDED). Kept as its own component (not inlined back to `<Link>`
 * at each call site) so every semantically-"back" link stays one grep away
 * (`<BackLink`) and any future back-specific behavior has a single place to
 * land, same rationale as before, just without the transition-marking side
 * effect.
 */
export function BackLink(props: BackLinkProps) {
  return <Link {...props} />
}
