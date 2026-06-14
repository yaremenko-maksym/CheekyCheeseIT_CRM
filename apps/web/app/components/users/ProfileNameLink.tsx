/**
 * ProfileNameLink — renders a user's display name as either a navigable
 * profile link or plain text, depending on the *viewer's* role.
 *
 * task-drop-profile-lockdown (RBAC, OWASP A01): DROP has NO access to any other
 * user's profile (the backend returns 403 for DROP→non-self). Surfacing a
 * `<Link to="/crm/profile/$userId">` for a DROP viewer would be a dead/forbidden
 * navigation that leaks the existence of a profile surface. For DROP viewers we
 * therefore render the name as PLAIN TEXT — no anchor, no navigation. Every other
 * role keeps the profile link exactly as before.
 *
 * Inline contacts (email/phone/telegram) on the team page are unaffected — they
 * are rendered separately and remain visible to DROP. This component governs the
 * *profile navigation* only.
 *
 * Single source of truth so the DROP gate is not duplicated across the team page,
 * document rows/cards and the document detail dialog.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { Role } from '@/lib/route-access'
import { cn } from '@/lib/utils'

interface ProfileNameLinkProps {
  /** Target user's id — used for the /crm/profile/$userId link. */
  userId: string
  /** The CURRENT viewer's role. DROP → plain text; everyone else → link. */
  viewerRole: Role
  /** Classes applied to the rendered element (link or span) identically. */
  className?: string
  /** data-testid forwarded to the rendered element. */
  testId?: string
  /** Optional onClick (e.g. stopPropagation in clickable rows) — link only. */
  onClick?: (e: React.MouseEvent) => void
  /** title attribute (tooltip) — applied to both link and span. */
  title?: string
  children: ReactNode
}

/**
 * Render the user's name. For DROP viewers it is plain, non-navigable text;
 * for all other roles it is a `<Link>` to that user's profile.
 */
export function ProfileNameLink({
  userId,
  viewerRole,
  className,
  testId,
  onClick,
  title,
  children,
}: ProfileNameLinkProps) {
  if (viewerRole === 'DROP') {
    return (
      <span className={cn(className)} title={title} data-testid={testId}>
        {children}
      </span>
    )
  }

  return (
    <Link
      to="/crm/profile/$userId"
      params={{ userId }}
      className={cn(className)}
      title={title}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </Link>
  )
}
