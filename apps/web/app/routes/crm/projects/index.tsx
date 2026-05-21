import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm, type FieldApi } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArchiveRestore,
  Briefcase,
  Calendar,
  Code2,
  DollarSign,
  Plus,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import type { AxiosError } from 'axios'
import type { CreateProjectDto, ProjectDto, ProjectMemberDto, ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { useAuth } from '@/context/auth'
import {
  useUnarchiveEntity,
  type UnarchiveCascadeEntity,
  type UnarchiveError,
} from '@/hooks/use-archive'
import { CascadeUnarchiveModal } from '@/components/archive/CascadeUnarchiveModal'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ReceiptField } from '@/components/ui/receipt-field'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { Skeleton } from '@/components/ui/skeleton'

const projectsSearchSchema = z.object({
  archived: z.boolean().optional(),
})

export const Route = createFileRoute('/crm/projects/')({
  validateSearch: (search) => projectsSearchSchema.parse(search),
  component: ProjectsPage,
})

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
}

type Filter = 'ALL' | 'ACTIVE' | 'CLOSED'

function getInitials(name: string) {
  return (name || '?').split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function TeamMemberRow({ userId, name, avatar, role }: { userId: string; name: string; avatar: string | null; role: string }) {
  return (
    <Link
      to="/crm/profile/$userId"
      params={{ userId }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors group"
      onClick={(e) => e.stopPropagation()}
    >
      <Avatar className="h-6 w-6 shrink-0">
        {avatar && <AvatarImage src={avatar} alt={name} />}
        <AvatarFallback className="text-[9px] font-semibold">{getInitials(name)}</AvatarFallback>
      </Avatar>
      <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors truncate flex-1">{name}</span>
      <Badge variant={ROLE_VARIANT[role] ?? 'secondary'} className="text-[9px] px-1.5 py-0 h-4 shrink-0">
        {ROLE_LABELS[role] ?? role}
      </Badge>
    </Link>
  )
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatar: string | null
}

// TanStack Form field render props require all 23 FieldApi generics — use unknown to avoid any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyField = FieldApi<any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any, any>

function ProjectsPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { user } = useAuth()
  const search = Route.useSearch()
  const isArchivedView = search.archived === true
  if (denied) return null
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const canCreate = user?.role === 'ADMIN' || user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'

  const [filter, setFilter] = useState<Filter>('ALL')
  const [showCreate, setShowCreate] = useState(false)
  const [deleteProject, setDeleteProject] = useState<ProjectDto | null>(null)
  const [cascadeProject, setCascadeProject] = useState<ProjectDto | null>(null)
  const [cascadeEntities, setCascadeEntities] = useState<UnarchiveCascadeEntity[]>([])

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects', { archived: isArchivedView }],
    queryFn: () =>
      api
        .get<ProjectDto[]>(`/projects${isArchivedView ? '?archived=true' : ''}`)
        .then((r) => r.data),
    enabled: !!user,
  })

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: canManage,
  })

  const seniorUsers = allUsers?.filter((u) => u.role === 'SENIOR') ?? []

  const createMutation = useMutation({
    mutationFn: (data: CreateProjectDto) => api.post<ProjectDto>('/projects', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowCreate(false)
      createForm.reset()
    },
  })

  const createForm = useForm({
    defaultValues: {
      name: '',
      companyName: '',
      domain: 'Other' as ItDomain,
      logoUrl: null as string | null,
      seniorId: '',
      rate: '' as unknown as number,
      currency: 'USDT' as 'USDT' | 'USD' | 'EUR' | 'UAH',
      startDate: new Date().toISOString().slice(0, 10),
      techStack: '',
      teamSize: '',
      benefits: '',
      paymentType: '',
      salaryReview: '',
      corpTech: '',
      notesGeneral: '',
    },
    onSubmit: async ({ value }) => {
      createMutation.mutate({
        name: value.name.trim(),
        companyName: value.companyName.trim(),
        domain: value.domain,
        logoUrl: value.logoUrl || null,
        seniorId: value.seniorId,
        rate: Number(value.rate),
        currency: value.currency,
        startDate: new Date(value.startDate).toISOString(),
        techStack: value.techStack.trim() || null,
        teamSize: value.teamSize.trim() || null,
        benefits: value.benefits.trim() || null,
        paymentType: value.paymentType.trim() || null,
        salaryReview: value.salaryReview.trim() || null,
        corpTech: value.corpTech.trim() || null,
        notesGeneral: value.notesGeneral.trim() || null,
      })
    },
  })

  // Archive is performed via `ArchiveConfirmDialog` (name-confirmation + impact warning)
  // — same UX as team / user archive, no inline mutation needed here.

  const filtered = projects?.filter((p) => filter === 'ALL' || p.status === filter) ?? []

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Проекты</h1>
          <p className="text-sm text-muted-foreground">Активные и завершённые проекты</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              variant={isArchivedView ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() =>
                navigate({
                  to: '/crm/projects',
                  search: isArchivedView ? {} : { archived: true },
                })
              }
              data-testid="toggle-archived-projects"
            >
              <ArchiveRestore className="h-4 w-4" />
              {isArchivedView ? 'Показать активные' : 'Показать архивных'}
            </Button>
          )}
          {canCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Новый проект
            </Button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        {(['ALL', 'ACTIVE', 'CLOSED'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'ALL' ? 'Все' : f === 'ACTIVE' ? 'Активные' : 'Завершённые'}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <Briefcase className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">
            {filter === 'ALL' ? 'Проектов пока нет' : `Нет ${filter === 'ACTIVE' ? 'активных' : 'завершённых'} проектов`}
          </p>
          {canManage && filter !== 'CLOSED' && (
            <Button size="sm" variant="outline" className="mt-4" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Создать проект
            </Button>
          )}
        </div>
      )}

      {/* Project cards */}
      <motion.div
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        variants={container}
        initial="hidden"
        animate="show"
        layout
      >
        <AnimatePresence mode="popLayout" initial={false}>
        {filtered.map((project) => {
          const activeMembers = project.members.filter((m) => m.leftAt === null)
          const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
          const activeHRs = activeMembers.filter((m) => m.role === 'HR')
          const activeAccountants = activeMembers.filter((m) => m.role === 'ACCOUNTANT')
          const isArchived = !!project.archivedAt

          return (
            <motion.div
              key={project.id}
              variants={item}
              layout
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
            >
              <Card
                data-testid={`project-card-${project.id}`}
                data-archived={isArchived ? 'true' : 'false'}
                className={cn(
                  'flex flex-col transition-all cursor-pointer hover:border-primary/40 hover:shadow-md hover:shadow-primary/5',
                  project.status === 'CLOSED' && 'opacity-70',
                  isArchived && 'opacity-60',
                )}
                onClick={() => navigate({ to: '/crm/projects/$projectId', params: { projectId: project.id } })}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-10 w-10 shrink-0 rounded-lg border border-border">
                      {project.logoUrl && <AvatarImage src={project.logoUrl} alt={project.companyName} className="object-contain" />}
                      <AvatarFallback className="rounded-lg text-xs font-semibold">{getInitials(project.companyName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'mt-0.5 h-1.5 w-1.5 rounded-full shrink-0',
                            project.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                          )}
                        />
                        <p className="font-semibold text-base truncate leading-tight">{project.companyName}</p>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground truncate">{project.name}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isArchived && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-[10px]"
                        >
                          В архиве
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">{project.domain}</Badge>
                      {isAdmin && isArchived && (
                        <ProjectUnarchiveButton
                          project={project}
                          onCascadeRequired={(entities) => {
                            setCascadeProject(project)
                            setCascadeEntities(entities)
                          }}
                        />
                      )}
                      {isAdmin && !isArchived && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive/60 hover:text-destructive hover:bg-destructive/10 shrink-0"
                          onClick={(e) => { e.stopPropagation(); setDeleteProject(project) }}
                          title="Архивировать проект"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 space-y-3">
                  {/* Rate */}
                  <div className="flex items-center gap-2 text-sm">
                    <DollarSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">Ставка:</span>
                    <span className="font-medium">{project.rate.toLocaleString()} {project.currency}</span>
                  </div>

                  {/* Dates */}
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">Старт:</span>
                    <span className="font-medium">
                      {new Date(project.startDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                    </span>
                    {project.endDate && (
                      <span className="text-muted-foreground">
                        — {new Date(project.endDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </span>
                    )}
                  </div>

                  {/* Team summary */}
                  <div className="border-t border-border pt-3 space-y-1.5">
                    <TeamMemberRow userId={project.seniorId} name={project.seniorName} avatar={null} role="SENIOR" />
                    {activeHRs.map((m) => (
                      <TeamMemberRow key={m.id} userId={m.userId} name={m.displayName} avatar={m.avatar} role="HR" />
                    ))}
                    {activeAccountants.map((m) => (
                      <TeamMemberRow key={m.id} userId={m.userId} name={m.displayName} avatar={m.avatar} role="ACCOUNTANT" />
                    ))}
                    {activeJuniors.length === 0 ? (
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-destructive/5 border border-destructive/20">
                        <Code2 className="h-3 w-3 text-destructive/60 shrink-0" />
                        <span className="text-xs text-destructive/80">Джун не назначен</span>
                      </div>
                    ) : (
                      activeJuniors.map((m) => (
                        <TeamMemberRow key={m.id} userId={m.userId} name={m.displayName} avatar={m.avatar} role="JUNIOR" />
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
        </AnimatePresence>
      </motion.div>

      {/* ── Create project dialog ── */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) { setShowCreate(false); createForm.reset() } }}>
        <CrmDialogContent maxWidth="max-w-md">
          <CrmDialogHeader>
            <DialogTitle>Новый проект</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody>
          <div className="space-y-3">
            <createForm.Field name="logoUrl">
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label>Логотип компании</Label>
                  <ReceiptField
                    value={field.state.value ?? ''}
                    onChange={(v) => field.handleChange(v || null)}
                    accept="image/*"
                    urlPlaceholder="https://example.com/logo.png"
                    urlHint="Вставьте ссылку на логотип или нажмите кнопку вставить"
                    fileHint="PNG, JPG, SVG — логотип компании"
                  />
                </div>
              )}
            </createForm.Field>

            <createForm.Field
              name="name"
              validators={{ onBlur: ({ value }: { value: string }) => { const r = createProjectSchema.shape.name.safeParse(value.trim()); return r.success ? undefined : r.error.issues[0]?.message } }}
            >
              {(field: AnyField) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>Название проекта</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="AI Platform v2"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </createForm.Field>

            <createForm.Field
              name="companyName"
              validators={{ onBlur: ({ value }: { value: string }) => { const r = createProjectSchema.shape.companyName.safeParse(value.trim()); return r.success ? undefined : r.error.issues[0]?.message } }}
            >
              {(field: AnyField) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>Компания</Label>
                    <Input
                      value={field.state.value}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="TechCorp AI"
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </createForm.Field>

            <createForm.Field name="domain">
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label>Домен</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    value={field.state.value}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => field.handleChange(e.target.value as ItDomain)}
                  >
                    {IT_DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}
            </createForm.Field>

            <createForm.Field
              name="seniorId"
              validators={{ onBlur: ({ value }: { value: string }) => { const r = createProjectSchema.shape.seniorId.safeParse(value); return r.success ? undefined : 'Выберите синьора' } }}
            >
              {(field: AnyField) => {
                const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                return (
                  <div className="space-y-1.5">
                    <Label className={cn(err && 'text-destructive')}>Синьор</Label>
                    <select
                      className={cn(
                        'w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring',
                        err ? 'border-destructive' : 'border-input',
                      )}
                      value={field.state.value}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    >
                      <option value="">— выберите синьора —</option>
                      {seniorUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                    </select>
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                )
              }}
            </createForm.Field>

            <createForm.Subscribe selector={(s: { values: { rate: number; currency: string } }) => ({ rate: s.values.rate, currency: s.values.currency })}>
              {({ rate, currency }: { rate: number; currency: string }) => (
                <AmountCurrencyInput
                  amount={String(rate ?? '')}
                  currency={currency as Currency}
                  onAmountChange={(v) => createForm.setFieldValue('rate', Number(v) as unknown as number)}
                  onCurrencyChange={(v) => createForm.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')}
                  label="Ставка"
                  placeholder="5000"
                />
              )}
            </createForm.Subscribe>

            <createForm.Field name="startDate">
              {(field: AnyField) => (
                <div className="space-y-1.5">
                  <Label>Дата начала</Label>
                  <Input
                    type="date"
                    value={field.state.value}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value)}
                  />
                </div>
              )}
            </createForm.Field>

            <div className="border-t border-border pt-3 space-y-3">
              {(
                [
                  'techStack',
                  'teamSize',
                  'benefits',
                  'paymentType',
                  'salaryReview',
                  'corpTech',
                ] as const
              ).map((fieldName) => {
                const labels: Record<string, string> = {
                  techStack: 'Стек технологий',
                  teamSize: 'Состав команды',
                  benefits: 'Бенефиты',
                  paymentType: 'Тип оплаты',
                  salaryReview: 'Пересмотр ЗП',
                  corpTech: 'Корп. технологии',
                }
                return (
                  <createForm.Field key={fieldName} name={fieldName}>
                    {(field: AnyField) => (
                      <div className="space-y-1.5">
                        <Label>{labels[fieldName]}</Label>
                        <Input
                          value={field.state.value as string}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            field.handleChange(e.target.value)
                          }
                          placeholder=""
                        />
                      </div>
                    )}
                  </createForm.Field>
                )
              })}
              <createForm.Field name="notesGeneral">
                {(field: AnyField) => (
                  <div className="space-y-1.5">
                    <Label>Общие заметки</Label>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring min-h-20 resize-y"
                      value={field.state.value as string}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                        field.handleChange(e.target.value)
                      }
                      placeholder=""
                    />
                  </div>
                )}
              </createForm.Field>
            </div>
          </div>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); createForm.reset() }}>Отмена</Button>
            <Button onClick={() => void createForm.handleSubmit()} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Создание...' : 'Создать'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* ── Archive project confirm — shared ArchiveConfirmDialog ── */}
      {deleteProject && (
        <ArchiveConfirmDialog
          entityType="project"
          entityId={deleteProject.id}
          entityName={deleteProject.name}
          onClose={() => setDeleteProject(null)}
        />
      )}

      {/* ── Cascade unarchive modal (project + paired senior/team) ── */}
      {cascadeProject && (
        <CascadeUnarchiveModalForProject
          project={cascadeProject}
          entities={cascadeEntities}
          onClose={() => {
            setCascadeProject(null)
            setCascadeEntities([])
          }}
        />
      )}
    </div>
  )
}

function ProjectUnarchiveButton({
  project,
  onCascadeRequired,
}: {
  project: ProjectDto
  onCascadeRequired: (entities: UnarchiveCascadeEntity[]) => void
}) {
  const unarchive = useUnarchiveEntity('project', project.id)
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    try {
      await unarchive.mutateAsync({})
    } catch (err) {
      const ax = err as AxiosError<UnarchiveError>
      if (ax.response?.status === 409 && ax.response.data?.requiresCascade) {
        onCascadeRequired(ax.response.data.entities)
      }
    }
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1 h-6 px-2"
      disabled={unarchive.isPending}
      onClick={(e) => void handleClick(e)}
      data-testid={`project-unarchive-${project.id}`}
    >
      <ArchiveRestore className="h-3 w-3" />
      <span className="text-[10px]">Восстановить</span>
    </Button>
  )
}

function CascadeUnarchiveModalForProject({
  project,
  entities,
  onClose,
}: {
  project: ProjectDto
  entities: UnarchiveCascadeEntity[]
  onClose: () => void
}) {
  const unarchive = useUnarchiveEntity('project', project.id)
  return (
    <CascadeUnarchiveModal
      projectName={project.name}
      entities={entities}
      isPending={unarchive.isPending}
      onConfirm={async () => {
        await unarchive.mutateAsync({ cascade: true })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}

// unused but kept for type safety
export type { ProjectMemberDto }
