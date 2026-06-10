import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm, type FieldApi } from '@tanstack/react-form'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { Archive, ArrowDown, ArrowUp, Briefcase, Plus, Search, UsersRound } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'
import { z } from 'zod'
import type { CreateProjectDto, ProjectDto, ProjectMemberDto, ItDomain } from '@crm/shared'
import { createProjectSchema, IT_DOMAINS } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImageUploadField } from '@/components/ui/image-upload-field'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectRow } from '@/components/projects/ProjectRow'
import { RejoinTeamDialog } from '@/components/users/RejoinTeamDialog'
import { useActiveTeam } from '@/hooks/use-active-team'

/**
 * Drop role - phase 1 (AC7): wraps `useActiveTeam` and short-circuits for
 * non-SENIOR viewers so the page never accidentally hides cards for
 * ADMIN/HR/ACCOUNTANT/JUNIOR. The underlying query always runs (same hook
 * order across renders).
 */
function useTeamlessSeniorGate(isSenior: boolean) {
  const { isTeamless, isLoading } = useActiveTeam()
  if (!isSenior) return { isTeamless: false, isLoading: false }
  return { isTeamless, isLoading }
}

// `archived` may arrive as a query-string ("true"/"false") for deep-links —
// `z.coerce.boolean()` accepts both `boolean` and string forms safely.
const projectsSearchSchema = z.object({
  archived: z.coerce.boolean().optional(),
})

export const Route = createFileRoute('/crm/projects/')({
  validateSearch: (search) => projectsSearchSchema.parse(search),
  component: ProjectsPage,
})

// Round 5: project lifecycle reduces to ACTIVE vs ARCHIVED — the legacy
// CLOSED state is gone. Round 7 (ut-44): tabs are «Все | Активные | Архив»
// for ADMIN; the «Все» tab fetches with `archived=all` and the «Архив»
// tab continues to use `archived=true`.
type StatusTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'

type ProjectSortKey = 'companyName' | 'rate' | 'startDate'
type SortDir = 'asc' | 'desc'

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}

// TanStack Form field render props require all 23 FieldApi generics — use unknown to avoid any
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyField = FieldApi<
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>
/* eslint-enable @typescript-eslint/no-explicit-any */

function ProjectsPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR'])
  const { user } = useAuth()
  const search = Route.useSearch()
  const isArchivedView = search.archived === true
  if (denied) return null
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Drop role - phase 1 (AC7): teamless SENIOR sees an empty-state with a
  // CTA to create or join a team. Page is otherwise locked out — backend
  // returns an empty list anyway, this is just a kinder surface.
  const { isTeamless: isTeamlessSenior, isLoading: isActiveTeamLoading } = useTeamlessSeniorGate(
    user?.role === 'SENIOR',
  )
  const [rejoinDialogOpen, setRejoinDialogOpen] = useState(false)

  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const canCreate = user?.role === 'ADMIN' || user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'

  // ut-44: tri-state tab — local "ACTIVE" / "ALL" state plus URL-driven "ARCHIVED".
  // We don't use URL for ALL/ACTIVE so deep-linking still defaults to active.
  const [filter, setFilter] = useState<StatusTab>('ALL')
  const [showCreate, setShowCreate] = useState(false)
  // ut-27 + ut-38: archive and unarchive actions removed from list cards;
  // both flows (including cascade restore for paired senior/team) live on the
  // project detail page header.

  // ut-43: unified toolbar state — search + senior filter + sort.
  const [searchQuery, setSearchQuery] = useState('')
  const [seniorFilter, setSeniorFilter] = useState<string>('ALL')
  const [sortKey, setSortKey] = useState<ProjectSortKey>('companyName')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // ut-32 / ut-44: keepPreviousData + useTransition keep the previous list
  // visible during the URL switch + refetch so the SegmentedToggle's gold-pill
  // layout animation isn't interrupted by a render that throws the list into
  // a skeleton/empty state mid-flight. The `archivedQuery` derives the query
  // param: ARCHIVED → `?archived=true`, ALL → `?archived=all`, ACTIVE → no
  // param (default backend behaviour).
  const currentTab: StatusTab = isArchivedView ? 'ARCHIVED' : filter
  const archivedQuery = currentTab === 'ARCHIVED' ? 'true' : currentTab === 'ALL' ? 'all' : ''
  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects', { archived: archivedQuery || 'active' }],
    queryFn: () =>
      api
        .get<ProjectDto[]>(`/projects${archivedQuery ? `?archived=${archivedQuery}` : ''}`)
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
  // Drop role - phase 2: list of DROP users for the optional Select in the
  // create-project form. The list is hidden entirely when empty so the form
  // looks identical to pre-phase-2 for companies that don't use drops.
  const dropUsers = allUsers?.filter((u) => u.role === 'DROP') ?? []

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
      logoDocumentId: null as string | null,
      logoExternalUrl: null as string | null,
      seniorId: '',
      // Drop role - phase 2. Empty string = «не выбран» (regular senior-project).
      // Non-empty uuid string = drop-project routed through the selected DROP user.
      dropId: '',
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
      // Drop role - phase 2. Only include `dropId` when the user picked one.
      // Empty string → regression: regular senior-project, body matches pre-
      // phase-2 shape exactly (no `dropId` key).
      const trimmedDropId = value.dropId.trim()
      createMutation.mutate({
        name: value.name.trim(),
        companyName: value.companyName.trim(),
        domain: value.domain,
        logoDocumentId: value.logoDocumentId,
        logoExternalUrl: value.logoExternalUrl,
        seniorId: value.seniorId,
        ...(trimmedDropId ? { dropId: trimmedDropId } : {}),
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

  // ut-43: client-side filter pipeline — search → senior → sort.
  const filtered = useMemo(() => {
    if (!projects) return []
    let list = [...projects]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (p) =>
          p.companyName.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.seniorName.toLowerCase().includes(q) ||
          (p.techStack ?? '').toLowerCase().includes(q),
      )
    }
    if (isAdmin && seniorFilter !== 'ALL') {
      list = list.filter((p) => p.seniorId === seniorFilter)
    }
    list.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortKey === 'companyName') {
        av = a.companyName
        bv = b.companyName
      } else if (sortKey === 'rate') {
        // rate is null for JUNIOR viewers; treat null as 0 for sort stability
        av = a.rate ?? 0
        bv = b.rate ?? 0
      } else if (sortKey === 'startDate') {
        av = new Date(a.startDate).getTime()
        bv = new Date(b.startDate).getTime()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [projects, searchQuery, seniorFilter, isAdmin, sortKey, sortDir])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-19 rounded-md" />
          ))}
        </div>
      </div>
    )
  }

  // Drop role - phase 1 (AC7): teamless SENIOR — full-page empty state
  // with the rejoin CTA. Other roles fall through to the regular UI.
  if (user?.role === 'SENIOR' && !isActiveTeamLoading && isTeamlessSenior) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Проекты</h1>
        </div>
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center"
          data-testid="projects-teamless-empty-state"
        >
          <UsersRound className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">У вас нет активной команды</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-md">
            Создайте свою команду или присоединитесь к команде дропа, чтобы получить доступ к
            проектам.
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={() => setRejoinDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Создать или выбрать команду
          </Button>
        </div>
        <RejoinTeamDialog open={rejoinDialogOpen} onClose={() => setRejoinDialogOpen(false)} />
      </div>
    )
  }

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
      // ALL or ACTIVE — both kept in local state.
      setFilter(next === 'ALL' ? 'ALL' : 'ACTIVE')
    })
  }

  // Round 5: tabs row — «Все | Активные | Архив». The CLOSED business
  // contract state is gone, so «Завершённые» is removed; «Архив» (ADMIN-only)
  // keeps its `toggle-archived-projects` testId for existing E2E specs.
  const tabs: ReadonlyArray<SegmentedToggleOption<StatusTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    ...(isAdmin
      ? ([
          { value: 'ARCHIVED', label: 'Архив', testId: 'toggle-archived-projects', icon: Archive },
        ] as const)
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

      {/* ut-25 + ut-26 + ut-33 + ut-44: status tabs row */}
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

      {/* ut-43: unified toolbar — search + senior filter (ADMIN) + sort key + direction */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4 pb-4">
          <div className="relative flex-1 min-w-50">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Поиск по компании, проекту, синьору…"
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="projects-search-input"
            />
          </div>

          {isAdmin && seniorUsers.length > 0 && (
            <Select value={seniorFilter} onValueChange={setSeniorFilter}>
              <SelectTrigger className="w-44" data-testid="projects-senior-filter">
                <SelectValue placeholder="Все синьоры" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все синьоры</SelectItem>
                {seniorUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="hidden h-6 w-px bg-border sm:block" aria-hidden />

          <Select value={sortKey} onValueChange={(v) => setSortKey(v as ProjectSortKey)}>
            <SelectTrigger className="w-52" data-testid="projects-sort-key">
              <SelectValue placeholder="Сортировка" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="companyName">По компании</SelectItem>
              <SelectItem value="rate">По ставке</SelectItem>
              <SelectItem value="startDate">По дате начала</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            aria-label={`Направление сортировки: ${sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'}`}
            data-testid="projects-sort-direction"
            data-dir={sortDir}
            className="h-9 w-9"
          >
            {sortDir === 'asc' ? (
              <ArrowUp className="h-4 w-4" />
            ) : (
              <ArrowDown className="h-4 w-4" />
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <Briefcase className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">
            {isArchivedView ? 'Архив пуст' : 'Проектов пока нет'}
          </p>
          {canManage && !isArchivedView && (
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Создать проект
            </Button>
          )}
        </div>
      )}

      {/* ut-41 + ut-42: row-list layout (was grid cards). Legacy
          `project-card-${id}` testid is preserved on the outer wrapper so
          existing E2E specs keep working; new `project-row-${id}` lives on
          the inner ProjectRow. */}
      {filtered.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <motion.div className="space-y-1" data-testid="projects-list">
              <AnimatePresence mode="popLayout" initial={false}>
                {filtered.map((project) => {
                  const isArchived = !!project.archivedAt
                  return (
                    <motion.div
                      key={project.id}
                      variants={item}
                      layout="position"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.08, ease: 'easeOut' }}
                      data-testid={`project-card-${project.id}`}
                      data-archived={isArchived ? 'true' : 'false'}
                    >
                      <ProjectRow project={project} />
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </motion.div>
          </CardContent>
        </Card>
      )}

      {/* ── Create project dialog ── */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false)
            createForm.reset()
          }
        }}
      >
        <CrmDialogContent maxWidth="max-w-md">
          <CrmDialogHeader>
            <DialogTitle>Новый проект</DialogTitle>
            <DialogDescription className="sr-only">Создание проекта</DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Логотип компании</Label>
                <ImageUploadField
                  value={{
                    documentId: (createForm.state.values as { logoDocumentId: string | null })
                      .logoDocumentId,
                    externalUrl: (createForm.state.values as { logoExternalUrl: string | null })
                      .logoExternalUrl,
                  }}
                  onChange={(v) => {
                    createForm.setFieldValue('logoDocumentId', v.documentId)
                    createForm.setFieldValue('logoExternalUrl', v.externalUrl)
                  }}
                  category="LOGO"
                  urlPlaceholder="https://example.com/logo.png"
                  testId="create-project-logo"
                />
              </div>

              <createForm.Field
                name="name"
                validators={{
                  onBlur: ({ value }: { value: string }) => {
                    const r = createProjectSchema.shape.name.safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field: AnyField) => {
                  const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                  return (
                    <div className="space-y-1.5">
                      <Label className={cn(err && 'text-destructive')}>Название проекта</Label>
                      <Input
                        value={field.state.value}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          field.handleChange(e.target.value)
                        }
                        onBlur={field.handleBlur}
                        placeholder="AI Platform v2"
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
                      />
                      {err && <p className="text-xs text-destructive">{err}</p>}
                    </div>
                  )
                }}
              </createForm.Field>

              <createForm.Field
                name="companyName"
                validators={{
                  onBlur: ({ value }: { value: string }) => {
                    const r = createProjectSchema.shape.companyName.safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field: AnyField) => {
                  const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                  return (
                    <div className="space-y-1.5">
                      <Label className={cn(err && 'text-destructive')}>Компания</Label>
                      <Input
                        value={field.state.value}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          field.handleChange(e.target.value)
                        }
                        onBlur={field.handleBlur}
                        placeholder="TechCorp AI"
                        className={cn(
                          err && 'border-destructive focus-visible:ring-destructive/30',
                        )}
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
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                        field.handleChange(e.target.value as ItDomain)
                      }
                    >
                      {IT_DOMAINS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </createForm.Field>

              <createForm.Field
                name="seniorId"
                validators={{
                  onBlur: ({ value }: { value: string }) => {
                    const r = createProjectSchema.shape.seniorId.safeParse(value)
                    return r.success ? undefined : 'Выберите синьора'
                  },
                }}
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
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                          field.handleChange(e.target.value)
                        }
                        onBlur={field.handleBlur}
                      >
                        <option value="">— выберите синьора —</option>
                        {seniorUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.displayName}
                          </option>
                        ))}
                      </select>
                      {err && <p className="text-xs text-destructive">{err}</p>}
                    </div>
                  )
                }}
              </createForm.Field>

              {/* Drop role - phase 2. Optional Select shown only when at least
                one DROP user exists. Empty = «не выбран» — regular senior-
                project (legacy regression path). Otherwise — drop-project. */}
              {dropUsers.length > 0 && (
                <createForm.Field name="dropId">
                  {(field: AnyField) => (
                    <div className="space-y-1.5">
                      <Label>Дроп (опционально)</Label>
                      <select
                        data-testid="create-project-drop-select"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                        value={field.state.value}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                          field.handleChange(e.target.value)
                        }
                        onBlur={field.handleBlur}
                      >
                        <option value="">— не выбран —</option>
                        {dropUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.displayName}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Если выбран — приходы по проекту пойдут через дропа (доля 5% по умолчанию).
                      </p>
                    </div>
                  )}
                </createForm.Field>
              )}

              <createForm.Subscribe
                selector={(s: { values: { rate: number; currency: string } }) => ({
                  rate: s.values.rate,
                  currency: s.values.currency,
                })}
              >
                {({ rate, currency }: { rate: number; currency: string }) => (
                  <AmountCurrencyInput
                    amount={String(rate ?? '')}
                    currency={currency as Currency}
                    onAmountChange={(v) =>
                      createForm.setFieldValue('rate', Number(v) as unknown as number)
                    }
                    onCurrencyChange={(v) =>
                      createForm.setFieldValue('currency', v as 'USDT' | 'USD' | 'EUR' | 'UAH')
                    }
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
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        field.handleChange(e.target.value)
                      }
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
            <Button
              variant="outline"
              onClick={() => {
                setShowCreate(false)
                createForm.reset()
              }}
            >
              Отмена
            </Button>
            <Button
              onClick={() => void createForm.handleSubmit()}
              disabled={createMutation.isPending}
            >
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
