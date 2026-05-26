import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/axios'

interface TeamMember {
  id: string
  displayName: string
  role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT'
  avatarUrl: string | null
  avatarDocumentId: string | null
}

const ROLE_LABEL: Record<TeamMember['role'], string> = {
  ADMIN: 'Админ',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

const ROLE_ORDER: Record<TeamMember['role'], number> = {
  SENIOR: 0,
  HR: 1,
  ACCOUNTANT: 2,
  JUNIOR: 3,
  ADMIN: 4,
}

export function TeamTab({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user-team', userId],
    queryFn: () =>
      api
        .get<TeamMember[]>(`/users/${userId}/team`)
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  const members = (data ?? []).slice().sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
  )
  if (members.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не состоит в команде
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {members.map((m) => (
          <Link
            key={m.id}
            to="/crm/profile/$userId"
            params={{ userId: m.id }}
            className="flex items-center gap-3 rounded border p-3 transition-colors hover:bg-accent"
          >
            <Avatar className="h-9 w-9">
              {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={m.displayName} />}
              <AvatarFallback>{m.displayName[0]}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{m.displayName}</p>
            </div>
            <Badge variant="outline">{ROLE_LABEL[m.role]}</Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
