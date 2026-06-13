import { Briefcase } from 'lucide-react'
import type { DropProjectDto } from '@crm/shared'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface DropProjectsListProps {
  projects: DropProjectDto[] | undefined
  isLoading: boolean
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
}

export function DropProjectsList({ projects, isLoading }: DropProjectsListProps) {
  return (
    <Card className="border-border/40 bg-card col-span-full" data-testid="drop-projects-list">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            МОИ DROP-ПРОЕКТЫ
          </span>
        </div>
      </CardHeader>

      <CardContent className="px-5 pb-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : !projects?.length ? (
          <p className="text-sm text-muted-foreground py-2">
            Нет активных drop-проектов. Обратитесь к администратору.
          </p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex items-center gap-3 rounded-md py-1"
                data-testid={`drop-project-item-${project.id}`}
              >
                {/* Company avatar */}
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="bg-secondary text-secondary-foreground text-xs font-semibold">
                    {getInitials(project.companyName)}
                  </AvatarFallback>
                </Avatar>

                {/* Company name */}
                <span className="text-sm font-medium truncate flex-1">{project.companyName}</span>

                {/* Senior name */}
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                  · {project.seniorDisplayName}
                </span>

                {/* Incomes count */}
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  · {project.incomesCount} прих.
                </span>

                {/* Status badge */}
                <Badge variant="outline" className="shrink-0 text-xs">
                  {project.status === 'active' ? (
                    <span className="flex items-center gap-1">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full bg-green-500"
                        aria-hidden="true"
                      />
                      Активный
                    </span>
                  ) : (
                    'Закрытый'
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
