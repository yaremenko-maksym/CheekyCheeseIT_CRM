import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/axios'

interface ProjectListItem {
  id: string
  name: string
  companyName: string
  status: 'ACTIVE' | 'CLOSED'
  startDate: string
  endDate: string | null
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
    <div className="flex items-center justify-between rounded border p-3">
      <div>
        <p className="font-medium">{p.name}</p>
        <p className="text-xs text-muted-foreground">
          {p.companyName} · {new Date(p.startDate).toLocaleDateString('ru-RU')}
          {p.endDate ? `–${new Date(p.endDate).toLocaleDateString('ru-RU')}` : ''}
        </p>
      </div>
      <Badge variant={p.status === 'ACTIVE' ? 'default' : 'outline'}>
        {p.status === 'ACTIVE' ? 'Активен' : 'Закрыт'}
      </Badge>
    </div>
  )
}
