import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
import { api } from '@/lib/axios'

interface ProjectListItem {
  id: string
  name: string
  companyName: string
  archivedAt: string | null
  startDate: string
  logoDocumentId: string | null
  logoExternalUrl: string | null
  rate: number
  currency: string
  domain: string | null
}

export function ProjectsTab({ userId, role }: { userId: string; role: string }) {
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

  // Round 5: project lifecycle is binary — ACTIVE (archivedAt = null) vs
  // ARCHIVED (archivedAt = timestamp). The history section reuses the
  // archived bucket since CLOSED-but-not-archived no longer exists.
  const projects = data ?? []
  const active = projects.filter((p) => p.archivedAt === null)
  const archived = projects.filter((p) => p.archivedAt !== null)

  // JUNIOR is bound to a single active project at a time — show just that, no history block
  if (role === 'JUNIOR') {
    const current = active[0] ?? null
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Текущий проект</CardTitle>
        </CardHeader>
        <CardContent>
          {current === null ? (
            <p className="text-sm text-muted-foreground">Сейчас не назначен на проект</p>
          ) : (
            <ProjectRow p={current} />
          )}
        </CardContent>
      </Card>
    )
  }

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
          <CardTitle className="text-base">История ({archived.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {archived.length === 0 ? (
            <p className="text-sm text-muted-foreground">Нет завершённых проектов</p>
          ) : (
            <div className="space-y-2">
              {archived.map((p) => (
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
  const isArchived = p.archivedAt !== null
  return (
    <Link
      to="/crm/projects/$projectId"
      params={{ projectId: p.id }}
      className="flex items-center gap-3 rounded border p-3 transition-colors hover:bg-accent"
    >
      <ProjectLogo
        documentId={p.logoDocumentId}
        externalUrl={p.logoExternalUrl}
        companyName={p.name}
        avatarClassName="h-10 w-10 shrink-0 [&_[data-slot=avatar-fallback]]:text-xs"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{p.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {p.companyName}
          {p.domain ? ` · ${p.domain}` : ''}
          {` · ${new Date(p.startDate).toLocaleDateString('ru-RU')}`}
          {isArchived && p.archivedAt
            ? `–${new Date(p.archivedAt).toLocaleDateString('ru-RU')}`
            : ''}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm">
          {p.rate} {p.currency}
        </p>
        <Badge
          variant={isArchived ? 'outline' : 'default'}
          className="mt-1 text-xs"
        >
          {isArchived ? 'В архиве' : 'Активен'}
        </Badge>
      </div>
    </Link>
  )
}
