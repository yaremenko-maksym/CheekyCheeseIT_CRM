import { Mail, Phone, Send } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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
}

export function UserProfileHeader({ user, actionsSlot }: UserProfileHeaderProps) {
  return (
    <div className="flex flex-col gap-4 border-b pb-6 md:flex-row md:items-center md:gap-6">
      <Avatar className="h-32 w-32 shrink-0">
        {user.avatar && <AvatarImage src={user.avatar} alt={user.displayName} />}
        <AvatarFallback className="text-3xl">{initials(user.displayName)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate text-2xl font-bold">{user.displayName}</h1>
          <Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>
            {ROLE_LABELS[user.role] ?? user.role}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
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
      </div>

      {actionsSlot && (
        <div className="flex shrink-0 items-center gap-2">
          {actionsSlot}
        </div>
      )}
    </div>
  )
}
