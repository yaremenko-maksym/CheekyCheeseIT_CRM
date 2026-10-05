/**
 * Avatar-fallback initials by naive single-space split: first letter of each
 * space-separated token, upper-cased, capped at 2 characters; `'?'` for an
 * empty, null or undefined name.
 *
 * Deduplicated from five byte-identical local `getInitials` copies (audit #10:
 * ProjectRow, projects/$projectId, team/index, team/$teamId,
 * CreateProjectFromHiredDialog). NOT interchangeable with the other
 * `getInitials` variants (components/users/constants.ts, UserAvatar.tsx,
 * @crm/shared) — those differ on leading/double whitespace and empty input.
 */
export function getInitialsBySpaceSplit(name?: string | null): string {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
