import { ChevronLeft, Mail, Phone, Send } from 'lucide-react'
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
  onBack?: () => void
  actionsSlot?: React.ReactNode
}

export function UserProfileHeader({ user, onBack, actionsSlot }: UserProfileHeaderProps) {
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
          <span className="inline-flex items-center gap-1.5">
            <Mail className="h-4 w-4" />
            {user.email}
          </span>
          {user.phone && (
            <span className="inline-flex items-center gap-1.5">
              <Phone className="h-4 w-4" />
              {user.phone}
            </span>
          )}
          {user.telegram && (
            <span className="inline-flex items-center gap-1.5">
              <Send className="h-4 w-4" />
              {user.telegram}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ChevronLeft className="h-4 w-4" />
            К списку
          </Button>
        )}
        {actionsSlot}
      </div>
    </div>
  )
}
