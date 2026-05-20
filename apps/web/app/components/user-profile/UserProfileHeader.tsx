import { CalendarDays, KanbanSquare, Mail, Phone, Send } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { UserProfileDto } from '@crm/shared'

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

function initials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export interface UserProfileHeaderProps {
  user: UserProfileDto
  actionsSlot?: React.ReactNode
  /** When true the avatar is wrapped in a button that opens the upload modal. */
  onAvatarClick?: () => void
  /** Whether to show the "Зарегистрирован XX.XX.XXXX" row in the header. */
  showCreatedAt?: boolean
  /** When true a "Доска собеседований" link is shown — used for SENIOR self-view. */
  showInterviewsLink?: boolean
}

export function UserProfileHeader({
  user,
  actionsSlot,
  onAvatarClick,
  showCreatedAt = true,
  showInterviewsLink = false,
}: UserProfileHeaderProps) {
  const avatarBody = (
    <Avatar className="h-32 w-32 shrink-0">
      {user.avatar && <AvatarImage src={user.avatar} alt={user.displayName} />}
      <AvatarFallback className="text-3xl">{initials(user.displayName)}</AvatarFallback>
    </Avatar>
  )

  return (
    <div className="flex flex-col gap-4 border-b pb-6 md:flex-row md:items-center md:gap-6">
      {onAvatarClick ? (
        <button
          type="button"
          onClick={onAvatarClick}
          className="group relative shrink-0 rounded-full ring-offset-background transition-shadow hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Изменить аватар"
        >
          {avatarBody}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            Изменить
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
          <a
            href={`mailto:${user.email}`}
            className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline transition-colors"
          >
            <Mail className="h-4 w-4" />
            {user.email}
          </a>
          {user.phone && (
            <a
              href={`tel:${user.phone}`}
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline transition-colors"
            >
              <Phone className="h-4 w-4" />
              {user.phone}
            </a>
          )}
          {user.telegram && (
            <a
              href={`https://t.me/${user.telegram.replace(/^@/, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline transition-colors"
            >
              <Send className="h-4 w-4" />
              {user.telegram}
            </a>
          )}
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
          <Link to="/crm/interviews" search={{ seniorId: user.id }}>
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
