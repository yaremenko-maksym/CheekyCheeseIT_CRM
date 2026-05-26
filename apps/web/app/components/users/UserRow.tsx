import { Link } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ArchiveRestore, Pencil, Trash2 } from 'lucide-react'
import type { UserProfileDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ROLE_LABELS, ROLE_VARIANT } from './constants'
import { UserAvatar } from './UserAvatar'

export type UserRowProps = {
  user: UserProfileDto
  isSelf: boolean
  onEdit: () => void
  onArchive: () => void
  onUnarchive: () => void
}

/**
 * Roomy carded row layout (variant C-v2 — User Testing round 1 update).
 *
 * Grid: `3fr (user info) | 1.4fr (right meta) | 64px (trailing actions)`
 *
 * Implementation note: the displayName is rendered inside a `<Link>` whose
 * `::before` pseudo-element is stretched (absolute inset-0) over the whole
 * row. Clicking anywhere in the row that is not a sibling actionable element
 * triggers the Link navigation. Email / Telegram / Phone are real `<a>` tags
 * that sit at a higher z-index than the Link's pseudo, so their click handlers
 * fire instead of the row navigation (and they all call `e.stopPropagation()`
 * defensively). Edit / Archive / Restore buttons sit even higher and call
 * `e.preventDefault()` so the row navigation never fires when they're clicked.
 *
 * States:
 *  - normal: trailing actions opacity 0.4 → 1.0 on hover, bg-muted/40 hover
 *  - self:   trailing actions always 1.0, primary-tinted background, delete disabled
 *  - admin (not-self): both edit (Pencil) and archive (Trash2) buttons hidden —
 *                       ADMIN cannot edit or archive another ADMIN (ut-2 + ut-10)
 *  - archived: opacity-50, badge «В архиве», single ArchiveRestore button
 *              instead of Pencil/Trash, in the same trailing column
 */
export function UserRow({ user, isSelf, onEdit, onArchive, onUnarchive }: UserRowProps) {
  const isArchived = !!user.archivedAt
  const techStack = Array.isArray(user.techStack) ? user.techStack : []
  // ut-10: ADMIN cannot edit or archive another ADMIN — hide both Pencil and
  // Trash for non-self ADMIN rows. Self-ADMIN keeps the disabled Trash button
  // so the "cannot archive yourself" affordance still surfaces, and Pencil
  // stays editable (ut-11 locks the role select inside the dialog instead).
  const isOtherAdmin = user.role === 'ADMIN' && !isSelf

  return (
    <div
      data-testid={`user-row-${user.id}`}
      data-user-id={user.id}
      // Boolean data-attrs serialize as "true"/"false"; emit only when truthy so
      // the DOM stays clean. E2E selectors `[data-archived="true"]` remain valid.
      data-archived={isArchived ? 'true' : undefined}
      data-self={isSelf ? 'true' : undefined}
      className={cn(
        'group/row relative rounded-md border border-transparent transition-colors',
        'min-h-19',
        'hover:bg-muted/40 hover:border-border/40',
        isSelf && 'bg-primary/6 border-primary/20 hover:bg-primary/10',
        isArchived && 'opacity-50 hover:opacity-70',
      )}
    >
      <div
        className="grid items-center"
        style={{ gridTemplateColumns: '3fr 1.4fr 64px' }}
      >
        {/* User info column */}
        <div className="flex items-center gap-3 min-w-0 py-3 pl-3 pr-4">
          <UserAvatar
            avatarDocumentId={user.avatarDocumentId}
            avatarUrl={user.avatarUrl}
            displayName={user.displayName}
            className="h-10 w-10 shrink-0 [&_[data-slot=avatar-fallback]]:bg-primary/20 [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:text-primary"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {/* Display name is the row's Link. Its `::before` pseudo-element
                  stretches over the entire row (via the parent `relative`)
                  so clicking anywhere in non-actionable space navigates to
                  the profile. Real <a> siblings (mailto/tel/t.me) sit higher
                  in z-stack and intercept their own clicks. */}
              <Link
                to="/crm/profile/$userId"
                params={{ userId: user.id }}
                aria-label={`Открыть профиль ${user.displayName}`}
                className={cn(
                  'text-sm font-medium truncate cursor-pointer hover:underline',
                  // Stretched-link pattern: ::before fills the closest
                  // positioned ancestor (the row outer div) so any click in
                  // unoccupied space triggers navigation.
                  "before:absolute before:inset-0 before:content-[''] before:z-[1]",
                )}
              >
                {user.displayName}
              </Link>
              {isSelf && (
                <span className="text-[10px] uppercase tracking-wide text-primary font-semibold relative z-[2]">
                  Вы
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <a
                href={`mailto:${user.email}`}
                className="truncate hover:text-foreground transition-colors relative z-[2]"
                onClick={(e) => e.stopPropagation()}
              >
                {user.email}
              </a>
              {user.telegram && (
                <>
                  <span aria-hidden className="relative z-[2]">·</span>
                  <a
                    // Telegram URL must strip the leading "@" — t.me/<username>
                    // is the canonical path; the leading "@" is display sugar.
                    href={`https://t.me/${user.telegram.replace(/^@/, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:text-foreground transition-colors relative z-[2]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {user.telegram}
                  </a>
                </>
              )}
              {user.phone && (
                <>
                  <span aria-hidden className="relative z-[2]">·</span>
                  <a
                    href={`tel:${user.phone}`}
                    className="truncate hover:text-foreground transition-colors relative z-[2]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {user.phone}
                  </a>
                </>
              )}
            </div>
            {techStack.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {techStack.slice(0, 5).map((tech) => (
                  <Badge
                    key={tech}
                    variant="outline"
                    className="text-[10px] font-mono px-1.5 py-0"
                  >
                    {tech}
                  </Badge>
                ))}
                {techStack.length > 5 && (
                  <span className="text-[10px] text-muted-foreground/70 self-center">
                    +{techStack.length - 5}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right meta */}
        <div className="flex flex-col items-end justify-center gap-1 py-3 pr-4">
          <div className="flex items-center gap-2">
            {isArchived && (
              <Badge variant="outline" className="text-[10px] border-muted-foreground/40 text-muted-foreground">
                В архиве
              </Badge>
            )}
            <Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>
              {ROLE_LABELS[user.role]}
            </Badge>
          </div>
          <span className="text-[11px] text-muted-foreground/70">
            {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true, locale: ru })}
          </span>
        </div>

        {/* Trailing actions column placeholder — visually overlaid by the absolute action stack below. */}
        <div aria-hidden className="self-stretch" />
      </div>

      {/* Action overlay — absolute over the trailing 64px column. Sits on top
          of the stretched Link via z-[3] so button clicks never fall through
          to the row navigation. Buttons also call preventDefault for belt-and-
          braces protection. */}
      <div
        className={cn(
          'absolute right-0 top-0 bottom-0 w-16',
          'flex flex-col items-center justify-center gap-1 py-2',
          'transition-opacity duration-150 z-[3]',
          'opacity-40 group-hover/row:opacity-100',
          isSelf && 'opacity-100',
          isArchived && 'opacity-100',
        )}
      >
        {isArchived ? (
          <Button
            data-testid={`user-row-unarchive-${user.id}`}
            variant="ghost"
            size="icon"
            aria-label="Восстановить из архива"
            title="Восстановить из архива"
            className="h-7 w-7"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onUnarchive()
            }}
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <>
            {/* Edit hidden for non-self ADMIN rows (ut-10 — ADMIN cannot edit
                another ADMIN). Self-ADMIN keeps it; the dialog locks role
                editing via ut-11 instead. */}
            {!isOtherAdmin && (
              <Button
                data-testid={`user-row-edit-${user.id}`}
                variant="ghost"
                size="icon"
                aria-label="Редактировать"
                title="Редактировать"
                className="h-7 w-7"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onEdit()
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Trash hidden for non-self ADMIN rows (ADMIN cannot archive
                another ADMIN). Self-ADMIN still renders it disabled so the
                "cannot archive yourself" tooltip is reachable. */}
            {!isOtherAdmin && (
              <Button
                data-testid={`user-row-archive-${user.id}`}
                variant="ghost"
                size="icon"
                aria-label={isSelf ? 'Нельзя архивировать себя' : 'Архивировать'}
                title={isSelf ? 'Нельзя архивировать себя' : 'Архивировать'}
                className="h-7 w-7 text-destructive hover:text-destructive disabled:opacity-30"
                disabled={isSelf}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!isSelf) onArchive()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
