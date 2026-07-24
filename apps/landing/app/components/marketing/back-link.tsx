import { Link } from '@tanstack/react-router'
import type { ComponentPropsWithoutRef } from 'react'
import { markNextTransitionLight } from '@/lib/page-transition'

type BackLinkProps = ComponentPropsWithoutRef<typeof Link>

/**
 * Drop-in replacement for `<Link>` at every semantically "back" navigation
 * (`careers_.$slug.tsx`'s "All roles" / "Back to careers", `__root.tsx`'s 404
 * "Back home" — docs/design/landing-redesign.md §M.3 step 3). Forces the
 * lightweight page-transition variant instead of the primary scrim+caret-line
 * sweep on the next navigation, since the visitor is going somewhere they've
 * already seen. `markNextTransitionLight()` runs synchronously in `onClick`
 * — React invokes a DOM node's own `onClick` prop before `<Link>`'s internal
 * handler fires on the SAME element, so this always wins the race against
 * `__root.tsx`'s `onBeforeNavigate` subscriber reading the pending variant.
 */
export function BackLink({ onClick, ...props }: BackLinkProps) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        markNextTransitionLight()
        onClick?.(event)
      }}
    />
  )
}
