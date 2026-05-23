import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Percent } from 'lucide-react'
import type { ProjectDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * "Мои проекты и доли" widget — SENIOR-only view on /crm/finance.
 *
 * For each project the SENIOR has access to, shows the effective share %:
 *  - override set → "X% [Override]"  (badge "Override")
 *  - override null → "X% (по умолчанию)"  where X = user.seniorSharePercent
 *
 * The list endpoint already filters by RBAC server-side — the SENIOR only
 * gets their own projects. We use the cached `['projects']` queryKey so the
 * widget stays in sync with edits made from /crm/projects.
 */
export function MyProjectShares() {
  const { user } = useAuth()
  const seniorDefault = user?.seniorSharePercent ?? 26

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    enabled: user?.role === 'SENIOR',
  })

  // Hide for non-SENIOR roles — the parent component is responsible for
  // RBAC gating too, but we double-check here to keep the widget self-contained.
  if (user?.role !== 'SENIOR') return null

  if (isLoading) {
    return (
      <Card data-testid="my-project-shares">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Мои проекты и доли
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 rounded-md" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const activeProjects = (projects ?? []).filter((p) => p.archivedAt === null)

  return (
    <Card data-testid="my-project-shares">
      <CardHeader className="pb-3">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Percent className="h-3.5 w-3.5" /> Мои проекты и доли
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {activeProjects.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">У вас пока нет активных проектов.</p>
        ) : (
          activeProjects.map((p) => {
            const overrideRaw = p.seniorSharePercentOverride
            const hasOverride = overrideRaw !== null && overrideRaw !== undefined
            const effective = hasOverride ? overrideRaw : seniorDefault
            return (
              <Link
                key={p.id}
                to="/crm/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm hover:bg-muted/40 transition-colors"
                data-testid={`my-project-share-${p.id}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground"> ({p.companyName})</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="font-semibold tabular-nums">{effective}%</span>
                  {hasOverride ? (
                    <Badge variant="secondary" className="text-[9px] py-0">Override</Badge>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">(по умолчанию)</span>
                  )}
                </span>
              </Link>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
