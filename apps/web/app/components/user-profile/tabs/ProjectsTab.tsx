import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { api } from '@/lib/axios'

interface ProjectListItem {
  id: string
  name: string
  companyName: string
  status: 'ACTIVE' | 'CLOSED'
  startDate: string
  endDate: string | null
  logoUrl: string | null
  rate: number
  currency: string
  domain: string | null
}

export function ProjectsTab({ userId, role: _role }: { userId: string; role: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user-projects', userId],
    queryFn: () =>
      api
        .get<ProjectListItem[]>(`/projects?userId=${userId}`)
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  const projects = data ?? []
  const active = projects.filter((p) => p.status === 'ACTIVE')
  const closed = projects.filter((p) => p.status === 'CLOSED')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Активные ({active.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">Нет активных проектов</p>
          ) : (
            <div className="space-y-2">
              {active.map((p) => (
                <ProjectRow key={p.id} p={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">История ({closed.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {closed.length === 0 ? (
            <p className="text-sm text-muted-foreground">Нет завершённых проектов</p>
          ) : (
            <div className="space-y-2">
              {closed.map((p) => (
                <ProjectRow key={p.id} p={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ProjectRow({ p }: { p: ProjectListItem }) {
  return (
    <Link
      to="/crm/projects/$projectId"
      params={{ projectId: p.id }}
      className="flex items-center gap-3 rounded border p-3 transition-colors hover:bg-accent"
    >
      <Avatar className="h-10 w-10 shrink-0">
        {p.logoUrl && <AvatarImage src={p.logoUrl} alt={p.name} />}
        <AvatarFallback className="text-xs">{p.name[0]}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{p.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {p.companyName}
          {p.domain ? ` · ${p.domain}` : ''}
          {` · ${new Date(p.startDate).toLocaleDateString('ru-RU')}`}
          {p.endDate ? `–${new Date(p.endDate).toLocaleDateString('ru-RU')}` : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm">
          {p.rate} {p.currency}
        </p>
        <Badge
          variant={p.status === 'ACTIVE' ? 'default' : 'outline'}
          className="mt-1 text-xs"
        >
          {p.status === 'ACTIVE' ? 'Активен' : 'Закрыт'}
        </Badge>
      </div>
    </Link>
  )
}
