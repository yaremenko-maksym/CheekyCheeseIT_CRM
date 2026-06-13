/**
 * /crm/project — JUNIOR hub «Мой проект» (round 3 redesign)
 *
 * Design spec: docs/design/junior-hub-round3.md
 * Changes from round 2:
 *  - items-start grid → no h-full stretching (root cause of empty space)
 *  - Left stack col-span-1: ProjectInfoCard (HR inline) + PersonaCard
 *  - Right wide col-span-2: SalarySnapshotCard
 *  - Bottom col-span-full: ProjectCredentialsSection (twoColumn)
 *  - Removed: ContractStatusCard, HrContactCard, useMyContract hook
 *
 * AC1: ставка/реальные идентичности отсутствуют в DOM.
 * AC3: redirect JUNIOR → /crm/project при логине (в index.tsx).
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { BookOpen, DollarSign, ExternalLink, Phone, Send, UserCircle } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { HrContactDto, ProjectDto, SalaryMetaDto, TransactionDto } from '@crm/shared'
import { hrContactSchema, salaryMetaSchema, transactionSchema } from '@crm/shared'
import { useLegend } from '@/hooks/use-legend'
import { useJuniorProjects } from '@/hooks/use-junior-projects'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { getAxiosStatus } from '@/lib/axios-utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
import { ProjectCredentialsSection } from '@/components/projects/ProjectCredentialsSection'

export const Route = createFileRoute('/crm/project')({
  component: JuniorProjectHub,
})

// ---------------------------------------------------------------------------
// Motion variants — same stagger pattern as /crm/index.tsx
// ---------------------------------------------------------------------------

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts[1]?.[0] ?? ''
  return (first + second).toUpperCase() || '?'
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useSalaryMeta() {
  return useQuery({
    queryKey: ['salary', 'meta'],
    queryFn: async () => {
      const res = await api.get<unknown>('/users/me/salary-meta')
      return salaryMetaSchema.parse(res.data)
    },
    staleTime: 60_000,
  })
}

function useSalaryTransactions() {
  return useQuery<TransactionDto[]>({
    queryKey: ['transactions', 'salary'],
    queryFn: async () => {
      try {
        const res = await api.get<unknown[]>('/transactions', { params: { type: 'SALARY' } })
        if (!Array.isArray(res.data)) return []
        return res.data
          .map((item) => transactionSchema.parse(item))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 3)
      } catch {
        return []
      }
    },
    staleTime: 60_000,
  })
}

function useHrContact(projectId: string | undefined) {
  return useQuery<HrContactDto | null>({
    queryKey: ['hr-contact', projectId],
    queryFn: async () => {
      try {
        const res = await api.get<unknown>(`/projects/${projectId}/hr-contact`)
        return hrContactSchema.parse(res.data)
      } catch (err: unknown) {
        if (getAxiosStatus(err) === 403 || getAxiosStatus(err) === 404) return null
        throw err
      }
    },
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

function JuniorProjectHub() {
  const { denied } = useRoleGuard(['JUNIOR'])

  const { data: projects, isLoading: projectsLoading } = useJuniorProjects()

  const [activeIdx, setActiveIdx] = useState(0)
  const activeProject = projects?.[activeIdx] ?? null
  const projectId = activeProject?.id

  if (denied) return null

  if (projectsLoading) {
    return (
      <div className="space-y-4" data-testid="junior-hub">
        <Skeleton className="h-7 w-44" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          {/* Left stack skeleton */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <Skeleton className="h-44 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
          </div>
          {/* Right wide skeleton */}
          <div className="lg:col-span-2">
            <Skeleton className="h-56 rounded-lg" />
          </div>
          {/* Bottom skeleton */}
          <div className="col-span-full">
            <Skeleton className="h-32 rounded-lg" />
          </div>
        </div>
      </div>
    )
  }

  if (!projects || projects.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground"
        data-testid="junior-hub"
      >
        <UserCircle className="h-10 w-10 opacity-30" />
        <p className="text-sm font-medium">Вас ещё не добавили в проект.</p>
        <p className="text-xs">Свяжитесь с вашим HR для добавления в проект.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="junior-hub">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Мой проект</h1>
        {activeProject && (
          <p className="text-sm text-muted-foreground">{activeProject.companyName}</p>
        )}
      </div>

      {/* Project switcher — only when >1 project */}
      {projects.length > 1 && (
        <ProjectSwitcher projects={projects} activeIdx={activeIdx} onSelect={setActiveIdx} />
      )}

      {activeProject && <HubCards project={activeProject} projectId={projectId!} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectSwitcher — button group when >1 active project
// ---------------------------------------------------------------------------

function ProjectSwitcher({
  projects,
  activeIdx,
  onSelect,
}: {
  projects: ProjectDto[]
  activeIdx: number
  onSelect: (i: number) => void
}) {
  return (
    <div
      className="flex gap-2 flex-wrap"
      data-testid="project-switcher"
      role="group"
      aria-label="Выбор проекта"
    >
      {projects.slice(0, 2).map((p, i) => (
        <Button
          key={p.id}
          variant={i === activeIdx ? 'default' : 'outline'}
          size="sm"
          onClick={() => onSelect(i)}
          aria-pressed={i === activeIdx}
          className="transition-opacity duration-200"
        >
          {p.companyName}
        </Button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// HubCards — round 3 bento (items-start eliminates h-full empty space)
// ---------------------------------------------------------------------------

function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)

  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    // items-start: grid rows wrap to content height — no empty stretching.
    // Structure: left 1/3 stack + right 2/3 salary + full-width credentials.
    // ContractStatusCard removed per task-junior-ut-round3 §5 (PM decision).
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
      variants={container}
      initial="hidden"
      animate="show"
      data-testid="junior-hub-bento"
    >
      {/* Left stack: О проекте (с HR) + Синьор проекта */}
      <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
        <ProjectInfoCard project={project} hrContact={hrContact ?? null} hrLoading={hrLoading} />
        <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
      </motion.div>

      {/* Right wide: Моя зарплата — col-span-2 (2/3 width on desktop) */}
      <motion.div variants={card} className="lg:col-span-2">
        <SalarySnapshotCard
          salaryMeta={salaryMeta ?? null}
          salaryTxs={salaryTxs ?? []}
          isLoading={salaryLoading}
        />
      </motion.div>

      {/* Bottom full-width: Пароли проекта — twoColumn for wide layout */}
      <motion.div variants={card} className="col-span-full">
        <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd twoColumn />
      </motion.div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// ProjectInfoCard — project meta + embedded HrInline (no separate HrContactCard)
// ---------------------------------------------------------------------------

function ProjectInfoCard({
  project,
  hrContact,
  hrLoading,
}: {
  project: ProjectDto
  hrContact: HrContactDto | null
  hrLoading: boolean
}) {
  const isActive = !project.archivedAt
  const statusVariant = isActive ? ('status-active' as const) : ('status-closed' as const)

  return (
    <Card className="border-border/40 bg-card" data-testid="project-info-card">
      <CardHeader className="flex flex-row items-start gap-3 pb-3">
        <ProjectLogo
          documentId={project.logoDocumentId ?? null}
          externalUrl={project.logoExternalUrl ?? null}
          companyName={project.companyName}
          avatarClassName="h-10 w-10 shrink-0 rounded-md"
        />
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold leading-tight truncate">
            {project.companyName}
          </CardTitle>
          {project.domain && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{project.domain}</p>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3 text-sm">
        {/* Project meta rows */}
        <div className="space-y-2">
          {project.startDate && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Старт</span>
              <span className="font-medium text-xs">
                {new Date(project.startDate).toLocaleDateString('ru-RU', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Статус</span>
            <Badge variant={statusVariant} className="text-xs">
              {isActive ? 'Активный' : 'Завершён'}
            </Badge>
          </div>
        </div>

        {/* HR contact — embedded, no separate Card */}
        <Separator className="opacity-30" />
        <section aria-label="Контакт HR">
          <HrInline hrContact={hrContact} isLoading={hrLoading} />
        </section>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// HrInline — compact HR block inside ProjectInfoCard (not a separate Card)
// ---------------------------------------------------------------------------

function HrInline({
  hrContact,
  isLoading,
}: {
  hrContact: HrContactDto | null
  isLoading: boolean
}) {
  if (isLoading) {
    return (
      <div data-testid="hr-inline">
        <p className="text-xs text-muted-foreground mb-1">Ваш HR</p>
        <Skeleton className="h-4 w-32" />
      </div>
    )
  }

  const hasContact = hrContact?.displayName || hrContact?.telegram || hrContact?.phone

  return (
    <div data-testid="hr-inline">
      <p className="text-xs text-muted-foreground mb-1">Ваш HR</p>
      {!hasContact ? (
        <p className="text-xs text-muted-foreground/60 italic">HR не назначен</p>
      ) : (
        <div className="space-y-1.5">
          {hrContact?.displayName && <p className="text-sm font-medium">{hrContact.displayName}</p>}
          <div className="flex flex-wrap gap-3">
            {hrContact?.telegram && (
              <a
                href={`https://t.me/${hrContact.telegram.replace(/^@/, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]"
              >
                <Send className="h-3 w-3 shrink-0" />
                {hrContact.telegram}
              </a>
            )}
            {hrContact?.phone && (
              <a
                href={`tel:${hrContact.phone}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]"
              >
                <Phone className="h-3 w-3 shrink-0" />
                {hrContact.phone}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PersonaCard — compact h-fit (round 3: no h-full, gap-3, avatar h-10)
// ---------------------------------------------------------------------------

interface PersonaCardProps {
  legend: { fullName?: string | null; presentedRole?: string | null } | null
  isLoading: boolean
}

function PersonaCard({ legend, isLoading }: PersonaCardProps) {
  const navigate = useNavigate()

  const fullName = legend?.fullName ?? null
  const presentedRole = legend?.presentedRole ?? null
  const initials = getInitials(fullName)

  if (isLoading) {
    return (
      <Card className="border-border/40 bg-card" data-testid="persona-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full shrink-0" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    // No h-full — card is h-fit; parent grid items-start prevents stretching
    <Card className="border-border/40 bg-card" data-testid="persona-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {/* h-10 (compact vs round2 h-12) per design spec */}
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarFallback className="bg-yellow-subtle text-avatar-text font-bold text-sm">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p
              className="font-semibold text-sm leading-tight truncate"
              data-testid="persona-fullname"
            >
              {fullName ?? '—'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 truncate" data-testid="persona-role">
              {presentedRole ?? '—'}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => void navigate({ to: '/crm/legend' })}
          data-testid="persona-open-legend-btn"
          aria-label="Открыть легенду"
        >
          <BookOpen className="h-3.5 w-3.5" />
          Открыть легенду
        </Button>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// SalarySnapshotCard — wide (col-span-2), text-3xl amount, full tx rows
// ---------------------------------------------------------------------------

interface SalarySnapshotCardProps {
  salaryMeta: SalaryMetaDto | null
  salaryTxs: TransactionDto[]
  isLoading: boolean
  className?: string
}

function SalarySnapshotCard({
  salaryMeta,
  salaryTxs,
  isLoading,
  className,
}: SalarySnapshotCardProps) {
  const baseClass = 'border-border/40 bg-card'
  const cardClass = className ? `${baseClass} ${className}` : baseClass

  if (isLoading) {
    return (
      <Card className={cardClass} data-testid="salary-snapshot-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    )
  }

  const hasRate = salaryMeta?.monthlySalary != null

  return (
    <Card className={cardClass} data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rate display — text-3xl on wide card (round 3 vs text-2xl in round 2) */}
        {hasRate ? (
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums" data-testid="salary-rate-amount">
              {Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU')}
            </span>
            <span className="text-sm text-muted-foreground uppercase">
              {salaryMeta!.salaryCurrency ?? ''}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">/ мес</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
            Ставка не назначена
          </p>
        )}

        {/* Last 3 payments — full rows with border-b separators */}
        {salaryTxs.length > 0 && (
          <div data-testid="salary-tx-list">
            <p className="text-xs text-muted-foreground mb-2">Последние выплаты</p>
            {salaryTxs.map((tx) => {
              const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
              const txVariant = isPaid ? ('paid' as const) : ('pending' as const)
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0"
                  data-testid="salary-tx-row"
                >
                  <span className="text-sm text-muted-foreground">
                    {tx.salaryMonth ??
                      new Date(tx.createdAt).toLocaleDateString('ru-RU', {
                        month: 'long',
                        year: 'numeric',
                      })}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-sm font-medium">
                      {Number(tx.amount).toLocaleString('ru-RU')} {tx.currency}
                    </span>
                    <Badge variant={txVariant} className="text-xs">
                      {isPaid ? 'Выплачено' : 'Ожидание'}
                    </Badge>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* All payments link */}
        <Link
          to="/crm/finance"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="salary-all-link"
        >
          <ExternalLink className="h-3 w-3" />
          Все мои выплаты
        </Link>
      </CardContent>
    </Card>
  )
}
