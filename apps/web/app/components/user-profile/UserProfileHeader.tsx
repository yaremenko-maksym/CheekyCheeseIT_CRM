import { CalendarDays, Camera, KanbanSquare, Mail, MailPlus, Phone, Send } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { UserProfileDto } from '@crm/shared'
import { UserAvatar } from '@/components/users/UserAvatar'
import { hasRealPhone } from '@/lib/format-phone'
import { safeTelegramHref } from '@/lib/tg-url'

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
}

export interface UserProfileHeaderProps {
  user: UserProfileDto
  actionsSlot?: React.ReactNode
  /** When set the avatar is wrapped in a button that opens the upload modal. */
  onAvatarClick?: (() => void) | undefined
  /** Whether to show the "Зарегистрирован XX.XX.XXXX" row in the header. */
  showCreatedAt?: boolean | undefined
  /** When true a "Доска собеседований" link is shown — used for SENIOR self-view. */
  showInterviewsLink?: boolean | undefined
}

export function UserProfileHeader({
  user,
  actionsSlot,
  onAvatarClick,
  showCreatedAt = true,
  showInterviewsLink = false,
}: UserProfileHeaderProps) {
  const avatarBody = (
    <UserAvatar
      avatarDocumentId={user.avatarDocumentId}
      avatarUrl={user.avatarUrl}
      displayName={user.displayName}
      className="h-20 w-20 shrink-0 text-2xl"
    />
  )

  return (
    // task-border-reset-and-profile-shell (2026-08-16, defect а): this used to
    // switch to a row at `md` (768px) — exactly the tablet test width. At 768
    // the row has avatar + this min-w-0 column + a shrink-0 actions column
    // (button(s)), but nothing inside the middle column's contact-links row
    // (email/phone/telegram, each an intrinsically-sized `<a>`) can shrink or
    // wrap below its own text width, so it silently overflowed UNDER the
    // actions column instead of wrapping — the "header colliding with
    // itself" (email text visible through the transparent outline button).
    // `lg` (1024px) is the first width with enough room for avatar + a full
    // email address + the action button(s) side by side without that
    // overflow (verified via Playwright at 768/1024) — below `lg` the header
    // stays in its already-correct stacked (flex-col) layout instead.
    <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-center lg:gap-4">
      {onAvatarClick ? (
        <button
          type="button"
          onClick={onAvatarClick}
          className="group relative shrink-0 rounded-full ring-offset-background transition-shadow hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Изменить аватар"
        >
          {avatarBody}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            <Camera className="h-12 w-12 text-white" strokeWidth={1.5} aria-hidden />
            <span className="sr-only">Изменить аватар</span>
          </span>
        </button>
      ) : (
        avatarBody
      )}

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate text-2xl font-bold">{user.displayName}</h1>
          <Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>
            {ROLE_LABELS[user.role] ?? user.role}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {/* ui-ux-designer PR #623 fidelity audit: `email` / `personalEmail`
              are admin-entered (`.max(255)`, security-review SR-M-1) with no
              structural word-break requirement — an unbroken run overflows
              its own box instead of wrapping, same defect class already
              fixed in notifications-bell.tsx (#620). `wrap-anywhere`
              (overflow-wrap: anywhere), not `break-words`: the CSS Text spec
              excludes `break-word` from the flex item's automatic-minimum-size
              calculation, so an unbreakable run still forces the box wide
              before break-word gets a chance to wrap — confirmed empirically
              here the same way #620 confirmed it (measured overflow before
              the fix). `min-w-0` lets the flex item actually shrink below its
              max-content size inside this `flex flex-wrap` row so
              wrap-anywhere has room to act. Verified live at 320/768/1024/1440
              with a 140-char unbroken personal address: previously bled
              under the header's action buttons (1440/1024) or was clipped
              off-screen entirely by `<main overflow-hidden>` (768/320,
              unreadable and unscrollable either way) — now wraps onto
              multiple lines within the contact-links row at every width. */}
          <a
            href={`mailto:${user.email}`}
            className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere underline-offset-4 hover:text-foreground hover:underline transition-colors"
          >
            <Mail className="h-4 w-4 shrink-0" />
            {user.email}
          </a>
          {user.personalEmail && (
            // §4.4 — personal address on file. Not (yet) a login method —
            // labelled "личный", not duplicated as a second "email" link, so
            // it reads as contact info rather than a second account.
            <a
              href={`mailto:${user.personalEmail}`}
              className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere underline-offset-4 hover:text-foreground hover:underline transition-colors"
              title="Личный email"
            >
              <MailPlus className="h-4 w-4 shrink-0" />
              {user.personalEmail}
            </a>
          )}
          {hasRealPhone(user.phone) && (
            <a
              href={`tel:${user.phone}`}
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline transition-colors"
            >
              <Phone className="h-4 w-4" />
              {user.phone}
            </a>
          )}
          {user.telegram &&
            (() => {
              // code-review round 2: validate before building a t.me/ link —
              // same guard `CandidateCard.tsx` uses for the (untrusted)
              // public-apply-form telegram field, reused here so this
              // CRM-internal field doesn't sit as the one unvalidated
              // telegram-link path left in the app.
              const href = safeTelegramHref(user.telegram)
              const className =
                'inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline transition-colors'
              if (!href) {
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <Send className="h-4 w-4" />
                    {user.telegram}
                  </span>
                )
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
                  <Send className="h-4 w-4" />
                  {user.telegram}
                </a>
              )
            })()}
        </div>

        {showCreatedAt && (
          <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            <span>
              Зарегистрирован{' '}
              {new Date(user.createdAt).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
              })}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {showInterviewsLink && (
          <Link to="/interviews" search={{ seniorId: user.id }}>
            <Button variant="outline" size="sm" className="gap-2">
              <KanbanSquare className="h-4 w-4" />
              Доска собеседований
            </Button>
          </Link>
        )}
        {actionsSlot}
      </div>
    </div>
  )
}
