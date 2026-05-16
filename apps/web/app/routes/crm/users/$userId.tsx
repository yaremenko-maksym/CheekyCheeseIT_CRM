import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowLeft, Mail, Phone, Send } from 'lucide-react'
import type { UserProfileDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/users/$userId')({
  component: UserProfilePage,
})

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

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function UserProfilePage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'])
  if (denied) return null
  const { userId } = Route.useParams()
  const { user } = useAuth()

  const { data: profile, isLoading } = useQuery({
    queryKey: ['users', userId],
    queryFn: () => api.get<UserProfileDto>(`/users/${userId}`).then((r) => r.data),
    enabled: !!user,
  })

  if (isLoading || !profile) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const isOwnProfile = user?.id === userId

  const telegramHandle = profile.telegram?.trim().replace(/^@/, '')
  const telegramUrl = telegramHandle ? `https://t.me/${telegramHandle}` : null

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
      className="space-y-6"
    >
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to=".." onClick={(e) => { e.preventDefault(); history.back() }}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Профиль сотрудника</h1>
          {isOwnProfile && (
            <p className="text-sm text-muted-foreground">
              Это ваш профиль —{' '}
              <Link to="/crm/profile" className="text-blue-500 hover:underline">
                редактировать
              </Link>
            </p>
          )}
        </div>
      </div>

      {/* Avatar + role */}
      <Card>
        <CardContent className="flex items-center gap-6 pt-6">
          <Avatar className="h-20 w-20 shrink-0">
            {profile.avatar && <AvatarImage src={profile.avatar} alt={profile.displayName} />}
            <AvatarFallback className="text-xl">{getInitials(profile.displayName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-semibold">{profile.displayName}</p>
            <Badge variant={ROLE_VARIANT[profile.role] ?? 'outline'} className="mt-1">
              {ROLE_LABELS[profile.role] ?? profile.role}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Contacts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Контакты</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm">
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
            <a
              href={`mailto:${profile.email}`}
              className="truncate text-blue-500 hover:underline"
            >
              {profile.email}
            </a>
          </div>

          {telegramUrl ? (
            <div className="flex items-center gap-3 text-sm">
              <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
              <a
                href={telegramUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                {profile.telegram?.startsWith('@') ? profile.telegram : `@${profile.telegram}`}
              </a>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Send className="h-4 w-4 shrink-0" />
              <span>Telegram не указан</span>
            </div>
          )}

          {profile.phone ? (
            <div className="flex items-center gap-3 text-sm">
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <a href={`tel:${profile.phone}`} className="text-blue-500 hover:underline">
                {profile.phone}
              </a>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Phone className="h-4 w-4 shrink-0" />
              <span>Телефон не указан</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* System info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Информация</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex justify-between">
            <span>Роль</span>
            <span className="font-medium text-foreground">
              {ROLE_LABELS[profile.role] ?? profile.role}
            </span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span>В системе с</span>
            <span className="font-medium text-foreground">
              {new Date(profile.createdAt).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
              })}
            </span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
