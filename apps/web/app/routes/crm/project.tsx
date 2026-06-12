/**
 * /crm/project — JUNIOR hub «Мой проект»
 *
 * Shows: project info · persona · contract status · salary snapshot
 *        · HR contact · quick links. Switcher when >1 active project.
 *
 * AC1: ставка/реальные идентичности отсутствуют в DOM.
 * AC3: redirect JUNIOR → /crm/project при логине (в index.tsx).
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import {
  BookOpen,
  CheckCircle2,
  DollarSign,
  ExternalLink,
  FileText,
  Phone,
  Send,
  UserCircle,
} from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  ContractStatusMeDto,
  HrContactDto,
  ProjectDto,
  SalaryMetaDto,
  TransactionDto,
} from '@crm/shared'
import {
  contractStatusMeDtoSchema,
  hrContactSchema,
  salaryMetaSchema,
  transactionSchema,
} from '@crm/shared'
import { useLegend } from '@/hooks/use-legend'
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

/** JUNIOR-facing: GET /api/projects returns only their projects with masking. */
function useJuniorProjects() {
  return useQuery<ProjectDto[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    staleTime: 5 * 60_000,
  })
}

function useMyContract() {
  return useQuery<ContractStatusMeDto | null>({
    queryKey: ['contracts', 'me', 'status'],
    queryFn: async () => {
      try {
        const res = await api.get<unknown>('/contracts/me/status')
        if (!res.data) return null
        return contractStatusMeDtoSchema.parse(res.data)
      } catch (err: unknown) {
        if (getAxiosStatus(err) === 404) return null
        throw err
      }
    },
    staleTime: 60_000,
  })
}

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
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
// HubCards — grid layout with all data cards
// ---------------------------------------------------------------------------

function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: contract, isLoading: contractLoading, isError: contractError } = useMyContract()
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)

  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    <motion.div className="space-y-4" variants={container} initial="hidden" animate="show">
      {/* Row 1: project info + persona (2-col on md+) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <motion.div variants={card}>
          <ProjectInfoCard project={project} />
        </motion.div>
        <motion.div variants={card}>
          <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
        </motion.div>
      </div>

      {/* Row 2: contract + salary (2-col on md+) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <motion.div variants={card}>
          <ContractStatusCard
            contract={contract ?? null}
            isLoading={contractLoading}
            isError={contractError}
          />
        </motion.div>
        <motion.div variants={card}>
          <SalarySnapshotCard
            salaryMeta={salaryMeta ?? null}
            salaryTxs={salaryTxs ?? []}
            isLoading={salaryLoading}
          />
        </motion.div>
      </div>

      {/* Row 3: HR contact — full width */}
      <motion.div variants={card}>
        <HrContactCard hrContact={hrContact ?? null} isLoading={hrLoading} />
      </motion.div>

      {/* Row 4: quick links — full width */}
      <motion.div variants={card}>
        <QuickLinksBar />
      </motion.div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// ProjectInfoCard
// ---------------------------------------------------------------------------

function ProjectInfoCard({ project }: { project: ProjectDto }) {
  // status derived from archivedAt — no dedicated status field in ProjectDto
  const isActive = !project.archivedAt
  const statusVariant = isActive ? ('status-active' as const) : ('status-closed' as const)

  return (
    <Card className="border-border/40 bg-card h-full" data-testid="project-info-card">
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
      <CardContent className="pt-0 space-y-2 text-sm">
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
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// PersonaCard — shows seniorName/seniorPresentedRole from legend masking
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
      <Card className="border-border/40 bg-card h-full" data-testid="persona-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full shrink-0" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border/40 bg-card h-full" data-testid="persona-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12 shrink-0">
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
// ContractStatusCard
// ---------------------------------------------------------------------------

interface ContractStatusCardProps {
  contract: ContractStatusMeDto | null
  isLoading: boolean
  isError: boolean
}

function ContractStatusCard({ contract, isLoading, isError }: ContractStatusCardProps) {
  const isSigned = contract?.status === 'SIGNED'
  const isReadyToSign = contract?.status === 'READY_TO_SIGN'
  const noContract = !contract && !isError

  if (isLoading) {
    return (
      <Card className="border-border/40 bg-card" data-testid="contract-status-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Контракт</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full rounded-md" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border/40 bg-card" data-testid="contract-status-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Контракт</CardTitle>
        {isSigned && <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" aria-hidden />}
      </CardHeader>
      <CardContent className="space-y-3">
        {isSigned && (
          <Badge
            variant="outline"
            className="text-xs border-green-500/40 text-green-400"
            data-testid="contract-status-badge"
          >
            Подписан
          </Badge>
        )}
        {isReadyToSign && (
          <>
            <Badge variant="default" className="text-xs" data-testid="contract-status-badge">
              Ожидает подписи
            </Badge>
            <Button
              size="sm"
              className="w-full"
              data-testid="contract-sign-btn"
              onClick={() => void window.open('/crm/onboarding', '_self')}
            >
              Подписать контракт
            </Button>
          </>
        )}
        {!isSigned && !isReadyToSign && !noContract && (
          <Badge variant="secondary" className="text-xs" data-testid="contract-status-badge">
            Черновик
          </Badge>
        )}
        {isError && (
          <Badge variant="secondary" className="text-xs" data-testid="contract-status-badge">
            Ошибка загрузки
          </Badge>
        )}
        {noContract && !isError && (
          <Badge variant="secondary" className="text-xs" data-testid="contract-status-badge">
            Контракт не оформлен
          </Badge>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// SalarySnapshotCard
// ---------------------------------------------------------------------------

interface SalarySnapshotCardProps {
  salaryMeta: SalaryMetaDto | null
  salaryTxs: TransactionDto[]
  isLoading: boolean
}

function SalarySnapshotCard({ salaryMeta, salaryTxs, isLoading }: SalarySnapshotCardProps) {
  if (isLoading) {
    return (
      <Card className="border-border/40 bg-card" data-testid="salary-snapshot-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    )
  }

  const hasRate = salaryMeta?.monthlySalary != null

  return (
    <Card className="border-border/40 bg-card" data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-3">
        {hasRate ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums" data-testid="salary-rate-amount">
                {Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU')}
              </span>
              <span className="text-xs text-muted-foreground uppercase">
                {salaryMeta!.salaryCurrency ?? ''}
              </span>
              <span className="text-xs text-muted-foreground ml-auto">/ мес</span>
            </div>
            {salaryMeta?.changedAt && (
              <p className="text-xs text-muted-foreground" data-testid="salary-changed-at">
                изменена{' '}
                {new Date(salaryMeta.changedAt).toLocaleDateString('ru-RU', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
            Ставка не назначена
          </p>
        )}
        {salaryTxs.length > 0 && (
          <>
            <Separator className="opacity-30" />
            <div className="space-y-1.5" data-testid="salary-tx-list">
              {salaryTxs.map((tx) => {
                const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
                const txVariant = isPaid ? ('paid' as const) : ('pending' as const)
                return (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between text-xs"
                    data-testid="salary-tx-row"
                  >
                    <span className="text-muted-foreground">
                      {tx.salaryMonth ??
                        new Date(tx.createdAt).toLocaleDateString('ru-RU', {
                          month: 'long',
                          year: 'numeric',
                        })}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums font-medium">
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
          </>
        )}
        <Separator className="opacity-50" />
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

// ---------------------------------------------------------------------------
// HrContactCard
// ---------------------------------------------------------------------------

interface HrContactCardProps {
  hrContact: HrContactDto | null
  isLoading: boolean
}

function HrContactCard({ hrContact, isLoading }: HrContactCardProps) {
  if (isLoading) {
    return (
      <Card className="border-border/40 bg-card" data-testid="hr-contact-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Ваш HR</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-5 w-40" />
        </CardContent>
      </Card>
    )
  }

  const hasContact = hrContact?.displayName || hrContact?.telegram || hrContact?.phone

  return (
    <Card className="border-border/40 bg-card" data-testid="hr-contact-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Ваш HR</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasContact && (
          <p className="text-sm text-muted-foreground/60 italic">
            HR не назначен. Обратитесь к администратору.
          </p>
        )}
        {hasContact && (
          <div className="space-y-2">
            {hrContact?.displayName && (
              <p className="text-sm font-medium">{hrContact.displayName}</p>
            )}
            <div className="flex flex-wrap gap-3">
              {hrContact?.telegram && (
                <a
                  href={`https://t.me/${hrContact.telegram.replace(/^@/, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Send className="h-3.5 w-3.5" />
                  {hrContact.telegram}
                </a>
              )}
              {hrContact?.phone && (
                <a
                  href={`tel:${hrContact.phone}`}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Phone className="h-3.5 w-3.5" />
                  {hrContact.phone}
                </a>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// QuickLinksBar
// ---------------------------------------------------------------------------

function QuickLinksBar() {
  return (
    <Card className="border-border/40 bg-card" data-testid="quick-links-bar">
      <CardContent className="flex flex-wrap gap-2 py-3">
        <Button variant="outline" size="sm" className="gap-2 h-9" asChild>
          <Link to="/crm/legend" data-testid="quick-link-legend">
            <BookOpen className="h-3.5 w-3.5" />
            Легенда
          </Link>
        </Button>
        <Button variant="outline" size="sm" className="gap-2 h-9" asChild>
          <Link to="/crm/documents">
            <FileText className="h-3.5 w-3.5" />
            Документы
          </Link>
        </Button>
        <Button variant="outline" size="sm" className="gap-2 h-9" asChild>
          <Link to="/crm/finance">
            <DollarSign className="h-3.5 w-3.5" />
            Финансы
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
