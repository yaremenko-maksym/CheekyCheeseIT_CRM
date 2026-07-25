import { Link } from '@tanstack/react-router'
import type { ComponentPropsWithoutRef } from 'react'
import { markNextTransitionBack } from '@/lib/page-transition'

type BackLinkProps = ComponentPropsWithoutRef<typeof Link>

/**
 * Drop-in replacement for `<Link>` at every semantically "back" navigation
 * (`careers_.$slug.tsx`'s "All roles" / "Back to careers", `__root.tsx`'s 404
 * "Back home" — docs/design/landing-redesign.md §M v3.1 step 3). Forces the
 * `'back'` lift-enter direction (content slides in from the top, §M v3.1
 * values table) on the next navigation, since the visitor is going somewhere
 * they've already seen. `markNextTransitionBack()` runs synchronously in
 * `onClick` — React invokes a DOM node's own `onClick` prop before
 * `<Link>`'s internal handler fires on the SAME element, so this always wins
 * the race against `__root.tsx`'s `onBeforeNavigate` subscriber reading the
 * pending direction.
 */
export function BackLink({ onClick, ...props }: BackLinkProps) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        markNextTransitionBack()
        onClick?.(event)
      }}
    />
  )
}
