import { Clock, XCircle } from 'lucide-react'
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
  /**
   * UX-M-1 / UX-L-1 (PR #670 designer review, fix-round 2). Mirrors
   * `ProjectRow.tsx`'s icon choice for the same two states (`Clock` for
   * "Ждёт решения", `XCircle` for "Отклонён") — `null` for
   * `ACTIVE`/`ARCHIVED`, which never had an icon in the list row either.
   * Unlike the row's own `Clock`, this one is NOT width-gated
   * (`hidden … xl:inline`): the header badge sits alone in a `flex-wrap`
   * row, not a ~86px table column, so there is no cramped width to hide it
   * from — a design decision recorded here, not inferred at the call site.
   */
  icon: typeof Clock | null
}

export function projectStatusBadge(project: ProjectStatusBadgeInput): ProjectStatusBadgeInfo {
  if (project.archivedAt) {
    return {
      status: 'ARCHIVED',
      label: 'В архиве',
      variant: 'outline',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
      icon: null,
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
        className: 'gap-1 border-amber-500/30 bg-amber-500/20 text-amber-300',
        icon: Clock,
      }
    case 'REJECTED':
      // Same destructive token family as ProjectRow.tsx's "Отклонён" badge.
      return {
        status: 'REJECTED',
        label: 'Отклонён',
        variant: 'outline',
        className: 'gap-1 border-destructive/30 bg-destructive/10 text-destructive',
        icon: XCircle,
      }
    case 'ACTIVE':
      return {
        status: 'ACTIVE',
        label: 'Активный',
        variant: 'default',
        className: '',
        icon: null,
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
  const Icon = info.icon
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
      {/* UX-M-1 / UX-L-1 (fix-round 2): unconditional, unlike ProjectRow.tsx's
          own width-gated Clock (`hidden … xl:inline`) — this badge lives
          alone in the header's `flex-wrap` row, not a ~86px table column.
          UX-M-2 (fix-round 2, designer circle 2): `shrink-0` is required
          here, not decorative — without it, the icon is a normal flex item
          with a default `min-width: auto`, so when the header's own
          `min-w-0` ancestor (`$projectId.tsx`) squeezes this badge below
          its content width (measured live: 768px viewport wraps "Ждёт
          решения" to two lines and narrows the badge to ~95px), flexbox
          shrinks the icon's WIDTH only — its explicit `h-3` height survives
          untouched because height is the cross axis in a row layout — and
          the Clock renders as a squashed 8.2×12px oval instead of a 12×12
          circle. `ProjectRow.tsx` already uses this exact same fix for the
          same reason on its own icons (avatars, status dots) one file over. */}
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden data-testid={`${testId}-icon`} />}
      {info.label}
    </Badge>
  )
}
