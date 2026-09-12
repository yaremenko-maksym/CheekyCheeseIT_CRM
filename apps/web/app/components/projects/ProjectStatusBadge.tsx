import type { ProjectStatus } from '@crm/shared'
import { Badge } from '@/components/ui/badge'

/**
 * task-project-page-status-badge (backlog 188). Single source of truth for
 * the project header/status badge — replaces the old
 * `!archivedAt ? 'Активный' : 'В архиве'` logic in
 * `apps/web/app/routes/_authenticated/projects/$projectId.tsx`, which
 * ignored `ProjectDetailDto.status` entirely and called a `DRAFT` or
 * `REJECTED` project "Активный".
 *
 * Priority: archive ALWAYS wins over the approval status — an archived
 * `DRAFT`/`REJECTED` project reads "В архиве", never its approval state.
 * This mirrors the priority `ProjectRow.tsx` already encodes via its own
 * `isArchived ? … : isPending ? … : isRejected ? … : …` chain
 * (task-project-status-filter-ui) — this file gives the detail page the
 * same rule instead of a second, drifted copy of it.
 */
export type ResolvedProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'REJECTED'

export interface ProjectStatusBadgeInput {
  status: ProjectStatus
  archivedAt: string | null
}

export interface ProjectStatusBadgeInfo {
  status: ResolvedProjectStatus
  label: string
  variant: 'default' | 'outline'
  className: string
}

export function projectStatusBadge(project: ProjectStatusBadgeInput): ProjectStatusBadgeInfo {
  if (project.archivedAt) {
    return {
      status: 'ARCHIVED',
      label: 'В архиве',
      variant: 'outline',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
    }
  }

  switch (project.status) {
    case 'DRAFT':
      // Same amber family as ProjectRow.tsx's "Ждёт решения" pending badge
      // (a shade darker fill/text so the two read as siblings, not a copy).
      return {
        status: 'DRAFT',
        label: 'Ждёт решения',
        variant: 'outline',
        className: 'border-amber-500/30 bg-amber-500/20 text-amber-300',
      }
    case 'REJECTED':
      // Same destructive token family as ProjectRow.tsx's "Отклонено" badge.
      return {
        status: 'REJECTED',
        label: 'Отклонён',
        variant: 'outline',
        className: 'border-destructive/30 bg-destructive/10 text-destructive',
      }
    case 'ACTIVE':
      return {
        status: 'ACTIVE',
        label: 'Активный',
        variant: 'default',
        className: '',
      }
    default: {
      // Exhaustiveness guard — a new `ProjectStatus` member fails the build
      // here instead of silently falling through to "Активный" the way the
      // old `!archivedAt` check did for DRAFT/REJECTED.
      const exhaustive: never = project.status
      throw new Error(`projectStatusBadge: unhandled project status ${String(exhaustive)}`)
    }
  }
}

/**
 * Render wrapper. Testid stays `project-archived-badge` on the archive
 * branch specifically — `apps/e2e/tests/crm/projects/projects-archive.spec.ts`
 * already queries it — and becomes the new `project-status-badge` for every
 * other resolved state. `data-status` is present on both so a caller can
 * always distinguish the four resolved states without depending on which
 * testid a given state happens to carry.
 */
export function ProjectStatusBadge({ project }: { project: ProjectStatusBadgeInput }) {
  const info = projectStatusBadge(project)
  const testId = info.status === 'ARCHIVED' ? 'project-archived-badge' : 'project-status-badge'
  return (
    <Badge
      variant={info.variant}
      // `text-xs` is NOT repeated here — `badgeVariants`' own base class
      // (badge.tsx) already applies it unconditionally, so adding it again
      // here would be an equivalent mutant no test could ever kill (verified:
      // the mutation gate's own first pass on this file flagged exactly
      // that survivor before this comment was written).
      className={info.className}
      data-testid={testId}
      data-status={info.status}
    >
      {info.label}
    </Badge>
  )
}
