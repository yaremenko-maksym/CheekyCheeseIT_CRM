import { Link } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'
import { ru } from 'date-fns/locale'
import { ArchiveRestore, Pencil, Trash2 } from 'lucide-react'
import type { UserProfileDto } from '@crm/shared'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ROLE_LABELS, ROLE_VARIANT, getInitials } from './constants'

export type UserRowProps = {
  user: UserProfileDto
  isSelf: boolean
  onEdit: () => void
  onArchive: () => void
  onUnarchive: () => void
}

/**
 * Roomy carded row layout (variant C-v2).
 *
 * Grid: `64px (leading actions) | 3fr (user info) | 1.4fr (right meta)`
 * Entire row is a Link to /crm/profile/$userId; action buttons stopPropagation.
 *
 * States:
 *  - normal: leading actions opacity 0.4 → 1.0 on hover, bg-muted/40 hover
 *  - self:   leading actions always 1.0, primary-tinted background, delete disabled
 *  - archived: opacity-50, badge «В архиве», single ArchiveRestore button instead of Pencil/Trash
 */
export function UserRow({ user, isSelf, onEdit, onArchive, onUnarchive }: UserRowProps) {
  const isArchived = !!user.archivedAt
  const techStack = Array.isArray(user.techStack) ? user.techStack : []

  return (
    <div
      data-testid={`user-row-${user.id}`}
      data-user-id={user.id}
      data-archived={isArchived}
      data-self={isSelf}
      className={cn(
        'group/row relative grid items-center rounded-md border border-transparent transition-colors',
        'min-h-19',
        'grid-cols-[64px_3fr_1.4fr]',
        'hover:bg-muted/40 hover:border-border/40',
        isSelf && 'bg-primary/6 border-primary/20 hover:bg-primary/10',
        isArchived && 'opacity-50 hover:opacity-70',
      )}
      style={{
        gridTemplateColumns: '64px 3fr 1.4fr',
      }}
    >
      {/* Leading actions (left 64px) — stopPropagation to avoid Link navigation */}
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1 self-stretch py-2',
          'transition-opacity duration-150',
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
          </>
        )}
      </div>

      {/* User info column (clickable to profile) */}
      <Link
        to="/crm/profile/$userId"
        params={{ userId: user.id }}
        className="flex items-center gap-3 min-w-0 py-3 pr-4 cursor-pointer"
        aria-label={`Открыть профиль ${user.displayName}`}
      >
        <Avatar className="h-10 w-10 shrink-0">
          {user.avatar && (
            <img
              src={user.avatar}
              alt={user.displayName}
              className="h-full w-full rounded-full object-cover"
            />
          )}
          <AvatarFallback className="bg-primary/20 text-xs text-primary">
            {getInitials(user.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{user.displayName}</span>
            {isSelf && (
              <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">
                Вы
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <span className="truncate">{user.email}</span>
            {user.telegram && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{user.telegram}</span>
              </>
            )}
            {user.phone && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{user.phone}</span>
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
      </Link>

      {/* Right meta */}
      <Link
        to="/crm/profile/$userId"
        params={{ userId: user.id }}
        className="flex flex-col items-end justify-center gap-1 py-3 pr-4 cursor-pointer"
        aria-hidden
        tabIndex={-1}
      >
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
      </Link>
    </div>
  )
}
