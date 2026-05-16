import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ProjectDto } from '@crm/shared'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/crm/project')({
  component: JuniorProjectPage,
})

function JuniorProjectPage() {
  const { denied } = useRoleGuard(['JUNIOR'])
  const navigate = useNavigate()

  const { data: projects, isLoading } = useQuery<ProjectDto[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (isLoading || denied) return
    if (projects && projects.length > 0) {
      void navigate({ to: '/crm/projects/$projectId', params: { projectId: projects[0]!.id }, replace: true })
    }
  }, [projects, isLoading, denied, navigate])

  if (denied) return null

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  if (!isLoading && (!projects || projects.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-lg font-medium">Проект не назначен</p>
        <p className="text-sm">Обратитесь к администратору или HR для добавления в проект.</p>
      </div>
    )
  }

  return null
}
