import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shared focus-visible ring for the marketing surface (landing-redesign.md §9
 * `.cc-focus-ring`) — links/buttons/inputs/burger all use the identical
 * pattern. Kept as a Tailwind utility string (not a global CSS class) so
 * `cn()` composition + `tailwind-merge` conflict-resolution keep working.
 */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[3px] focus-visible:rounded-md'
