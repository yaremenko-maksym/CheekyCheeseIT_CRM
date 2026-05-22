import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm, type FieldApi } from '@tanstack/react-form'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import {
  Archive,
  Briefcase,
  Calendar,
  Code2,
  DollarSign,
  Plus,
} from 'lucide-react'
import { useState, useTransition } from 'react'
import { z } from 'zod'
import type { CreateProjectDto, ProjectDto, ProjectMemberDto, ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { useAuth } from '@/context/auth'
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

// Round 5: project lifecycle reduces to ACTIVE vs ARCHIVED — the legacy
// CLOSED state is gone. Tabs: «Все | Активные | Архив». The «Архив» tab is
// derived from the `?archived=true` URL search param; the other two stay
// in local state.
type Filter = 'ALL' | 'ACTIVE'
type StatusTab = Filter | 'ARCHIVED'

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
  // ut-27 + ut-38: archive and unarchive actions removed from list cards;
  // both flows (including cascade restore for paired senior/team) live on the
  // project detail page header.

  // ut-32: keepPreviousData + useTransition keep the previous list visible
  // during the URL switch + refetch so the SegmentedToggle's gold-pill
  // layout animation is never interrupted by a React render that throws
  // the list into a skeleton/empty state mid-flight.
  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects', { archived: isArchivedView }],
    queryFn: () =>
      api
        .get<ProjectDto[]>(`/projects${isArchivedView ? '?archived=true' : ''}`)
        .then((r) => r.data),
    enabled: !!user,
    placeholderData: keepPreviousData,
  })

  const [, startTransition] = useTransition()

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

  // Round 5: with the CLOSED status gone, both ALL and ACTIVE tabs show the
  // same set (all non-archived projects). The «Архив» tab uses the URL
  // search param and a different query, so it doesn't go through this filter.
  const filtered = projects ?? []

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

  // ut-25: derive currently-selected tab from URL (archived) + local filter
  const currentTab: StatusTab = isArchivedView ? 'ARCHIVED' : filter

  const handleTabChange = (next: StatusTab) => {
    // ut-32: wrap the URL/state change in startTransition so React can keep
    // the previous page rendered while the new query resolves — otherwise
    // the toggle's layoutId pill animation gets cancelled by the suspended
    // render and the user sees a hard pop instead of a smooth slide.
    startTransition(() => {
      if (next === 'ARCHIVED') {
        navigate({ to: '/crm/projects', search: { archived: true } })
        return
      }
      if (isArchivedView) {
        navigate({ to: '/crm/projects', search: {} })
      }
      setFilter(next)
    })
  }

  // Round 5: tabs row — «Все | Активные | Архив». The CLOSED business
  // contract state is gone, so «Завершённые» is removed; «Архив» (ADMIN-only)
  // keeps its `toggle-archived-projects` testId for existing E2E specs.
  const tabs: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    ...(isAdmin
      ? ([{ value: 'ARCHIVED', label: 'Архив', testId: 'toggle-archived-projects', icon: Archive }] as const)
      : []),
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Проекты</h1>
          <p className="text-sm text-muted-foreground">Активные и завершённые проекты</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Новый проект
            </Button>
          )}
        </div>
      </div>

      {/* ut-25 + ut-26 + ut-33: status tabs row, unified through SegmentedToggle */}
      <SegmentedToggle<StatusTab>
        value={currentTab}
        onChange={handleTabChange}
        options={tabs}
        ariaLabel="Фильтр проектов"
        variant="tabs"
        size="sm"
        layoutId="projects-status-tabs"
        className="w-fit"
        testId="projects-status-tabs"
      />

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <Briefcase className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">
            {isArchivedView ? 'Архив пуст' : 'Проектов пока нет'}
          </p>
          {canManage && !isArchivedView && (
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
      >
        <AnimatePresence mode="popLayout" initial={false}>
        {filtered.map((project) => {
          // ut-34: card preview shows only SENIOR + JUNIOR(s). HR / accountant
          // / future-other roles are intentionally hidden in the list — they
          // remain visible on the project detail page. Empty state «Нет джуна»
          // is rendered when there are no active juniors so the slot stays
          // visually consistent across all cards.
          const activeMembers = project.members.filter((m) => m.leftAt === null)
          const activeJuniors = activeMembers.filter((m) => m.role === 'JUNIOR')
          const isArchived = !!project.archivedAt

          return (
            <motion.div
              key={project.id}
              variants={item}
              layout="position"
              exit={{ opacity: 0 }}
              transition={{ duration: 0.08, ease: 'easeOut' }}
            >
              <Card
                data-testid={`project-card-${project.id}`}
                data-archived={isArchived ? 'true' : 'false'}
                className={cn(
                  'flex flex-col transition-all cursor-pointer hover:border-primary/40 hover:shadow-md hover:shadow-primary/5',
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
                            isArchived ? 'bg-muted-foreground/40' : 'bg-emerald-500',
                          )}
                        />
                        <p className="font-semibold text-base truncate leading-tight">{project.companyName}</p>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground truncate">{project.name}</p>
                    </div>
                    {/* ut-27 + ut-38: trash & unarchive controls removed from
                        list cards. Both archive and unarchive are now driven
                        from the project detail page header — clicking the card
                        navigates into it. */}
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

                  {/* Dates — round 5: only start date shown; archive timestamp is admin-only on detail page. */}
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">Старт:</span>
                    <span className="font-medium">
                      {new Date(project.startDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                    </span>
                  </div>

                  {/* ut-34: SENIOR + JUNIOR(s) only in card preview */}
                  <div className="border-t border-border pt-3 space-y-1.5">
                    <TeamMemberRow userId={project.seniorId} name={project.seniorName} avatar={null} role="SENIOR" />
                    {activeJuniors.length === 0 ? (
                      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-destructive/5 border border-destructive/20">
                        <Code2 className="h-3 w-3 text-destructive/60 shrink-0" />
                        <span className="text-xs text-destructive/80">Нет джуна</span>
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

      {/* ut-27 + ut-38: Archive + Unarchive (including cascade modal) live on
          the project detail page header — list cards have no inline actions. */}
    </div>
  )
}

// unused but kept for type safety
export type { ProjectMemberDto }
