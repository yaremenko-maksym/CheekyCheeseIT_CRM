import { Link } from '@tanstack/react-router'
import type { ProjectDto } from '@crm/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProjectLogo } from './ProjectLogo'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type ProjectRowProps = {
  project: ProjectDto
}

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const DATE_FORMAT_OPTS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
}

/**
 * Horizontal row-list layout for the /crm/projects page (ut-41 + ut-42).
 *
 * Pattern mirrors `UserRow` (apps/web/app/components/users/UserRow.tsx):
 *  - Stretched-link via ::before pseudo-element: the entire row is clickable
 *    and navigates to the project detail page. Inner <a> tags for senior and
 *    junior names sit at a higher z-index (z-[2] > stretched-link z-[1]) and
 *    use onClick stopPropagation to intercept their own clicks.
 *  - No inline edit / archive controls (consistent with ut-27 + ut-38).
 *    Archive + Edit live on the project detail page header.
 *  - `data-testid="project-row-${id}"` for E2E; preserves the legacy
 *    `project-card-${id}` testid via the wrapper in the parent route so
 *    existing specs don't break.
 */
export function ProjectRow({ project }: ProjectRowProps) {
  const isArchived = !!project.archivedAt
  const activeMembers = project.members.filter((m) => m.leftAt === null)
  const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
  const firstJunior = activeJuniors[0]
  const remainingJuniors = activeJuniors.length - 1

  return (
    <div
      data-testid={`project-row-${project.id}`}
      data-project-id={project.id}
      data-archived={isArchived ? 'true' : undefined}
      className={cn(
        'group/row relative rounded-md border border-transparent transition-colors',
        'hover:bg-muted/40 hover:border-border/40',
        isArchived && 'opacity-60 hover:opacity-80',
      )}
    >
      <div
        className="grid items-center gap-3 px-3 py-3 min-h-19"
        style={{ gridTemplateColumns: '3fr 1.4fr 1.4fr 1.2fr 1fr' }}
      >
        {/* Project info column — logo + name + company */}
        <div className="flex items-center gap-3 min-w-0">
          <ProjectLogo
            documentId={project.logoDocumentId}
            externalUrl={project.logoExternalUrl}
            companyName={project.companyName}
            fallback={getInitials(project.companyName)}
            avatarClassName="h-10 w-10 shrink-0 rounded-lg border border-border [&_[data-slot=avatar-fallback]]:rounded-lg [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:font-semibold"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  isArchived ? 'bg-muted-foreground/40' : 'bg-emerald-500',
                )}
              />
              {/* Stretched-link pattern: ::before fills the row so any click in
                  non-actionable space navigates to the detail page. */}
              <Link
                to="/crm/projects/$projectId"
                params={{ projectId: project.id }}
                aria-label={`Открыть проект ${project.companyName}`}
                className={cn(
                  'text-sm font-semibold truncate cursor-pointer hover:underline leading-tight',
                  "before:absolute before:inset-0 before:content-[''] before:z-[1]",
                )}
              >
                {project.companyName}
              </Link>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{project.name}</p>
          </div>
        </div>

        {/* Senior column */}
        <div className="flex items-center gap-2 min-w-0">
          <Avatar className="h-7 w-7 shrink-0">
            <AvatarFallback className="text-[10px] font-semibold bg-primary/20 text-primary">
              {getInitials(project.seniorName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
              Синьор
            </p>
            {/* Inner link sits above the row-level stretched-link (z-[2] > z-[1]).
                stopPropagation страховка на случай если bubbling доберётся до
                row-level click handler в будущем. */}
            <Link
              to="/crm/profile/$userId"
              params={{ userId: project.seniorId }}
              onClick={(e) => e.stopPropagation()}
              data-testid={`project-row-${project.id}-senior-link`}
              className="relative z-[2] block text-xs font-medium truncate hover:underline hover:text-primary underline-offset-2"
            >
              {project.seniorName}
            </Link>
          </div>
        </div>

        {/* Junior column */}
        <div className="flex items-center gap-2 min-w-0">
          {firstJunior ? (
            <>
              <Avatar className="h-7 w-7 shrink-0">
                {firstJunior.avatarUrl && (
                  <AvatarImage src={firstJunior.avatarUrl} alt={firstJunior.displayName} />
                )}
                <AvatarFallback className="text-[10px] font-semibold">
                  {getInitials(firstJunior.displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
                  Джун
                </p>
                {/* `<div>` (not `<p>`) used as the truncate parent because we
                    nest an inline `<a>` for the junior name. Keeps `+N` suffix
                    next to the name when present. */}
                <div className="text-xs font-medium truncate">
                  <Link
                    to="/crm/profile/$userId"
                    params={{ userId: firstJunior.userId }}
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`project-row-${project.id}-junior-link`}
                    className="relative z-[2] hover:underline hover:text-primary underline-offset-2"
                  >
                    {firstJunior.displayName}
                  </Link>
                  {remainingJuniors > 0 && (
                    <span className="text-muted-foreground/70 font-normal">
                      {' '}
                      +{remainingJuniors}
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Empty avatar slot keeps the text-block X-position consistent
                  with the «with-junior» branch so all columns share a baseline grid. */}
              <div
                className="h-7 w-7 shrink-0 rounded-full border border-dashed border-destructive/30"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
                  Джун
                </p>
                <p className="text-xs font-medium text-destructive/80 flex items-center gap-1.5 truncate">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-destructive/50 shrink-0"
                    aria-hidden
                  />
                  Нет джуна
                </p>
              </div>
            </>
          )}
        </div>

        {/* Rate + date column.
            rate / currency are null for JUNIOR viewers (finance masking, RBAC A01).
            Render an em-dash placeholder so the column still occupies its grid cell. */}
        <div className="flex flex-col items-end justify-center text-right">
          <p className="text-sm font-semibold tabular-nums">
            {project.rate != null ? (
              <>
                {project.rate.toLocaleString()}{' '}
                <span className="text-xs text-muted-foreground font-normal">
                  {project.currency}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground/40 italic text-xs">—</span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground/80 tabular-nums">
            {new Date(project.startDate).toLocaleDateString('uk-UA', DATE_FORMAT_OPTS)}
          </p>
        </div>

        {/* Status / badges column */}
        <div className="flex items-center justify-end gap-1.5">
          {isArchived ? (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-[10px]"
            >
              В архиве
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              {project.domain}
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}
