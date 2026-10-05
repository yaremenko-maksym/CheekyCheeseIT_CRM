import { Link } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { Trans, useLingui } from '@lingui/react/macro'
import { Archive, ArrowLeft, Calendar, DollarSign, Globe, Pencil } from 'lucide-react'
import type { ProjectDetailDto, Role } from '@crm/shared'
import { formatDate, formatNumber } from '@crm/shared'
import { type ExchangeRates, fmtUsd } from '@/routes/_authenticated/finance/constants'
import { useLocale } from '@/lib/i18n'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { ProjectStatusBadge } from '@/components/projects/ProjectStatusBadge'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { type UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { ProjectHeaderApprovalNote } from './ProjectApprovalBanners'
import { ProjectUnarchiveHeaderButton } from './ProjectUnarchive'

export interface ProjectHeroProps {
  project: ProjectDetailDto
  /** `user?.id` of the viewer, forwarded to `ProjectHeaderApprovalNote`. */
  viewerId: string | undefined
  /** `user?.role` of the viewer, gates the drop badge. */
  viewerRole: Role | undefined
  /** Today's exchange rates (page-owned query); undefined until loaded. */
  rates: ExchangeRates | undefined
  /** RBAC flags computed by the page (`useProjectPermissions`), passed through unchanged. */
  isAdmin: boolean
  canOpenEdit: boolean
  onEdit: () => void
  onArchive: () => void
  onCascadeRequired: (entities: UnarchiveCascadeEntity[]) => void
}

/**
 * Hero banner of the project detail page (logo, title, badges, header actions, stat chips),
 * moved verbatim from `$projectId.tsx`. The page keeps owning the dialog state and the
 * permission computation; it passes flags and callbacks down.
 */
export function ProjectHero({
  project,
  viewerId,
  viewerRole,
  rates,
  isAdmin,
  canOpenEdit,
  onEdit,
  onArchive,
  onCascadeRequired,
}: ProjectHeroProps) {
  const { t } = useLingui()
  const locale = useLocale()
  return (
    <motion.div
      className="relative overflow-hidden rounded-2xl border border-border/40 bg-card"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      {/* Ambient glow blob */}
      <div
        className="pointer-events-none absolute -top-16 -left-16 h-64 w-64 rounded-full opacity-[0.07] blur-3xl"
        style={{ background: '#f5c542' }}
      />
      {/* UX-H-1 / COPY-M-5 (fix-round 3): the row flip used to happen at
            `sm:` (640px) — on a 768px tablet the title column had only
            ~95px to work with, wrapping the "Ждёт решения" pill's own text
            and breaking a long rejection reason into 7-20 narrow lines.
            `scrollWidth <= clientWidth` never caught it because nothing
            actually overflowed the viewport. Pushed to `lg:` (1024px) so
            640-1023 stacks the header like 320 does — full-width badge row,
            buttons on their own line below the title. */}
      <div className="relative flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: back + logo + title */}
        <div className="flex items-center gap-4 min-w-0">
          <Link to="/projects" className="shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="relative shrink-0">
            <div
              className="absolute inset-0 rounded-xl opacity-30 blur-md"
              style={{ background: '#f5c542' }}
            />
            <ProjectLogo
              documentId={project.logoDocumentId}
              externalUrl={project.logoExternalUrl}
              companyName={project.companyName}
              fallback={getInitialsBySpaceSplit(project.companyName)}
              avatarClassName="relative h-14 w-14 rounded-xl shadow-lg"
            />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight truncate leading-tight">
              {project.companyName}
            </h1>
            <p className="text-sm text-muted-foreground truncate mt-0.5">{project.name}</p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {/* task-project-page-status-badge (backlog 188). Single
                    source of truth for the label — was `!archivedAt`-only
                    before, which called a DRAFT/REJECTED project
                    "Активный" (see ProjectStatusBadge.tsx doc). */}
              <ProjectStatusBadge project={project} />
              {/* task-projects-followups-web (backlog 201, fix-round 2,
                    COPY-M-1): mounted immediately after the status badge, not
                    below the whole badge row — "от <синьор>" / the quoted
                    rejection reason is a grammatical continuation of "Ждёт
                    решения" / "Отклонён", not a standalone sentence, and
                    reads as attached to the wrong neighbor (the domain badge)
                    once the drop/domain badges sit between it and the status
                    badge it explains. */}
              <ProjectHeaderApprovalNote project={project} viewerId={viewerId} />
              {/* Drop role - phase 2. Distinct blue/info badge for drop-
                    projects so it's obvious at a glance that money flows
                    through a DROP user. Hidden for regular senior-projects.
                    RBAC: only ADMIN/HR/ACCOUNTANT see this badge — JUNIOR
                    must not know the identity behind the legend is a DROP. */}
              {project.dropId &&
                (viewerRole === 'ADMIN' || viewerRole === 'HR' || viewerRole === 'ACCOUNTANT') && (
                  <Badge
                    variant="outline"
                    className="border-blue-500/30 bg-blue-500/10 text-blue-400 text-xs"
                    data-testid="project-drop-badge"
                  >
                    <Trans>Проєкт з дропом</Trans>
                  </Badge>
                )}
              <Badge variant="outline" className="text-xs">
                {project.domain}
              </Badge>
            </div>
          </div>
        </div>

        {/* ut-28: Explicit Edit + Archive buttons (replaces «Действия» dropdown
              and former «Завершить» button). Visible to ADMIN/HR (full edit)
              and ACCOUNTANT (override-only edit). */}
        <div className="flex items-center gap-2 shrink-0 self-start lg:self-center">
          {canOpenEdit && !project.archivedAt && (
            <Button
              size="sm"
              variant="outline"
              onClick={onEdit}
              className="gap-1.5"
              data-testid="project-edit-button"
            >
              <Pencil className="h-3.5 w-3.5" />
              <Trans>Редагувати</Trans>
            </Button>
          )}
          {isAdmin && !project.archivedAt && (
            <Button
              size="sm"
              variant="outline"
              onClick={onArchive}
              className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-testid="project-archive-button"
            >
              <Archive className="h-3.5 w-3.5" />
              <Trans>Архівувати</Trans>
            </Button>
          )}
          {isAdmin && project.archivedAt && (
            <ProjectUnarchiveHeaderButton
              projectId={project.id}
              projectName={project.name}
              onCascadeRequired={onCascadeRequired}
            />
          )}
        </div>
      </div>

      {/* Stat chips row */}
      <div className="flex gap-3 px-6 pb-5 flex-wrap">
        {/* rate / currency are null for JUNIOR (finance masking, RBAC A01).
              Only render the stat chip when finance data is available. */}
        {project.rate != null && project.currency != null && (
          <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
            <DollarSign className="h-4 w-4 text-emerald-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                {t`Ставка`}
              </p>
              <p className="text-sm font-semibold tabular-nums">
                {formatNumber(project.rate, locale)} {project.currency}
              </p>
              {rates && project.currency !== 'USD' && project.currency !== 'USDT' && (
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  ≈ {fmtUsd(project.rate, project.currency, rates)}
                </p>
              )}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
          <Calendar className="h-4 w-4 text-blue-400 shrink-0" />
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t`Старт`}</p>
            <p className="text-sm font-semibold">
              {formatDate(project.startDate, locale, 'short')}
            </p>
          </div>
        </div>
        {project.archivedAt && (
          <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
            <Calendar className="h-4 w-4 text-amber-400 shrink-0" />
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                {t`В архіві з`}
              </p>
              <p className="text-sm font-semibold">
                {formatDate(project.archivedAt, locale, 'short')}
              </p>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 flex-1 min-w-[140px]">
          <Globe className="h-4 w-4 text-violet-400 shrink-0" />
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t`Домен`}</p>
            <p className="text-sm font-semibold">{project.domain}</p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
